import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";

/**
 * The accessibility scan every end-to-end test runs (STD-TEST-007): axe checks each screen a page
 * in the test's browser context visits, and a serious or critical violation fails the test.
 */

/** The WCAG levels Hobbots meets, plus axe's best practices; the impact decides what fails. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];

const BLOCKING: ReadonlySet<string> = new Set(["serious", "critical"]);

const CONTRAST = "color-contrast";

/** How many settled looks must agree before a contrast failure counts. */
const CONFIRMING_LOOKS = 2;

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type NodeResult = AxeResults["violations"][number]["nodes"][number];

/**
 * Findings the scan sets aside, each matched by its rule and the markup of the element: a false
 * alarm with its reason, or a known violation with the issue that fixes it. Keep each one narrow,
 * so a new violation of the same rule still fails.
 */
const SET_ASIDE: ReadonlyArray<{ readonly rule: string; readonly node: RegExp; readonly why: string }> = [
  {
    rule: "aria-hidden-focus",
    node: /^#root <div id="root" data-aria-hidden="true" aria-hidden="true">/,
    why: "A modal dialog hides the app behind it from screen readers and keeps the focus inside itself, so the app's controls are out of reach while it is open.",
  },
  // Known violations, fixed in #839.
  {
    rule: "color-contrast",
    node: /-trigger-(summary|browser|terminal|files|changes) > span:nth-child\(2\) <span>/,
    why: "#839: a Workbench tab the Task did not use is dimmed below 4.5:1.",
  },
  {
    rule: "color-contrast",
    node: /<span class="rounded-tag px-(tag-x|1\.5) py-0\.5 text-xs font-bold whitespace-nowrap bg-line text-mint">/,
    why: "#839: mint status tags on the line color reach 4.45:1, less inside dimmed rows.",
  },
  {
    rule: "color-contrast",
    node: /<time datetime="[^"]*">since /,
    why: "#839: the label color on a card reaches 4.11:1.",
  },
  {
    rule: "color-contrast",
    node: /<span data-slot="badge" data-variant="running"/,
    why: "#839: the Running badge reaches 3.43:1.",
  },
  {
    rule: "color-contrast",
    node: /<span class="[^"]*bg-rose\/22 text-rose/,
    why: "#839: the rose count bubble reaches 3.89:1.",
  },
  {
    rule: "label-content-name-mismatch",
    node: /<a aria-label="[^"]*" class="hop-on-hover cut /,
    why: "#839: a hob card is named by its name and state, not everything it shows.",
  },
  {
    rule: "label-content-name-mismatch",
    node: /<button type="button" aria-label="See the change to /,
    why: "#839: a change row reads the kind and path, but is named for where it leads.",
  },
  {
    rule: "label-content-name-mismatch",
    node: /<a aria-label="Open Your hobs: /,
    why: "#839: Home's hall door shows a count, but is named for where it leads.",
  },
  {
    rule: "label-content-name-mismatch",
    node: /<a aria-label="[^"]+ is on /,
    why: "#839: a quest's party row on Home and a hob's page is named as a sentence, not by what it shows.",
  },
];

const setAside = (rule: string, node: NodeResult) =>
  SET_ASIDE.some((entry) => entry.rule === rule && entry.node.test(`${node.target.join(" ")} ${node.html}`));

/** How long a screen gets to render its data after the address changes, before the scan. */
const SETTLE_MS = 400;

/** A failed scan because the page moved on or closed: the screen it was scanning is gone. */
const GONE = new RegExp(
  [
    "Execution context was destroyed",
    "Target (page, context or browser )?(has been )?closed",
    "has been closed",
    "frame was detached",
    "navigat",
    // The page loaded again between injecting axe and running it.
    "reading 'run(Partial)?'",
  ].join("|"),
  "i",
);

export interface Violation {
  /** The address of the screen, without the origin. */
  readonly screen: string;
  readonly rule: string;
  readonly impact: string;
  readonly help: string;
  /** The elements that break the rule: a selector, the start of its markup and axe's reason. */
  readonly targets: ReadonlyArray<string>;
}

const screenOf = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * Waits for the screen's motion to end, up to three seconds: a fade measured halfway reads as low
 * contrast. Motion that starts while it waits, such as a bar fading in after a tab switch, is waited
 * for too. Endless animations, such as a working hob's sparkle, are left running.
 */
const settle = (page: Page) =>
  page.evaluate(async () => {
    const deadline = Date.now() + 3000;
    const moving = () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY),
        );
    for (let now = moving(); now.length > 0 && Date.now() < deadline; now = moving()) {
      const finished = Promise.all(now.map((animation) => animation.finished.catch(() => undefined)));
      await Promise.race([finished, new Promise((done) => setTimeout(done, deadline - Date.now()))]);
    }
  });

const axe = (page: Page) =>
  // Legacy mode runs axe inside the page. The default opens a blank page in the test's context to
  // merge frame results, which a test that counts or waits for pages would see.
  new AxeBuilder({ page }).withTags(TAGS).setLegacyMode();

const blocking = (results: AxeResults) =>
  results.violations.filter((violation) => BLOCKING.has(violation.impact ?? ""));

/** Where a node is, as axe names it, plus its markup: what it is across two runs. */
const nodeKey = (node: NodeResult) => `${node.target.join(" ")} ${node.html}`;

/**
 * Scans the page as it is now and returns its serious and critical violations. The scan runs
 * beside the test, so an element can be fading in while it is measured: a contrast failure counts
 * only when the looks taken once that motion has ended find the same element failing. Only a scan
 * with a contrast failure waits for motion, which keeps the rest fast.
 */
const scan = async (page: Page): Promise<ReadonlyArray<Violation>> => {
  const screen = screenOf(page);
  // A whole log opens as plain text in a tab of its own: the browser's viewer, not a Hobbots screen.
  if (!(await page.evaluate(() => document.contentType === "text/html"))) return [];
  let violations = blocking(await axe(page).analyze())
    .map((violation) => ({ ...violation, nodes: violation.nodes.filter((node) => !setAside(violation.id, node)) }))
    .filter((violation) => violation.nodes.length > 0);
  // The test runs on while the scan looks, so each look can catch a different fade: a contrast
  // failure counts only when every settled look finds the same element failing.
  for (let look = 0; look < CONFIRMING_LOOKS && violations.some((violation) => violation.id === CONTRAST); look++) {
    await settle(page);
    const again = blocking(await axe(page).withRules([CONTRAST]).analyze()).flatMap((violation) => violation.nodes);
    const still = new Set(again.map(nodeKey));
    violations = violations
      .map((violation) =>
        violation.id === CONTRAST
          ? { ...violation, nodes: violation.nodes.filter((node) => still.has(nodeKey(node))) }
          : violation,
      )
      .filter((violation) => violation.nodes.length > 0);
  }
  return violations.map((violation) => ({
    screen,
    rule: violation.id,
    impact: violation.impact ?? "",
    help: violation.help,
    targets: violation.nodes.map(
      (node) =>
        `${node.target.join(" ")}  ${node.html.slice(0, 120)}  ${(node.failureSummary ?? "").replaceAll("\n", " ")}`,
    ),
  }));
};

/** Explains the violations as a failure message: one block per rule and screen. */
const explain = (violations: ReadonlyArray<Violation>) =>
  [
    `${violations.length} serious or critical accessibility violation(s) (STD-TEST-007):`,
    ...violations.map(
      (violation) =>
        `- [${violation.impact}] ${violation.rule} on ${violation.screen}: ${violation.help}\n` +
        violation.targets.map((target) => `    ${target}`).join("\n"),
    ),
  ].join("\n");

/**
 * Watches every page of a browser context: after each change of address it scans the screen once,
 * and `finish` scans the screens still open. Scans run one at a time, beside the test's own steps.
 */
export class AccessibilityWatch {
  private readonly found = new Map<string, Violation>();
  private readonly scanned = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(private readonly context: BrowserContext) {
    for (const page of context.pages()) this.watch(page);
    context.on("page", (page) => this.watch(page));
  }

  /** Waits for the scans in flight, scans every open page, and returns what was found. */
  async finish(): Promise<ReadonlyArray<Violation>> {
    for (const page of this.context.pages()) this.enqueue(page, 0, true);
    await this.queue;
    if (this.failure !== undefined) throw this.failure;
    return [...this.found.values()];
  }

  private watch(page: Page) {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.enqueue(page, SETTLE_MS, false);
    });
  }

  private enqueue(page: Page, settle: number, always: boolean) {
    this.queue = this.queue.then(() =>
      this.scanOnce(page, settle, always).catch((error: unknown) => {
        this.failure ??= error;
      }),
    );
  }

  private async scanOnce(page: Page, settle: number, always: boolean) {
    if (page.isClosed() || !page.url().startsWith("http")) return;
    if (settle > 0) await new Promise((done) => setTimeout(done, settle));
    if (page.isClosed()) return;
    const screen = screenOf(page);
    if (!always && this.scanned.has(screen)) return;
    try {
      for (const violation of await scan(page)) {
        this.found.set(`${violation.screen} ${violation.rule} ${violation.targets.join(",")}`, violation);
      }
      this.scanned.add(screen);
    } catch (error) {
      if (!GONE.test(String(error))) throw error;
    }
  }
}

/** Fails the test with the violations the watch found, and attaches them to its report. */
export const report = async (violations: ReadonlyArray<Violation>, testInfo: TestInfo) => {
  if (violations.length === 0) return;
  await testInfo.attach("accessibility-violations.json", {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json",
  });
  throw new Error(explain(violations));
};
