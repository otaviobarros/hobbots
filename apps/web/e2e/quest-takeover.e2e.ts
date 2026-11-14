import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { openQuest } from "./quest-sheet.ts";

// Issue #1449 in the browser: you take over a Task's files and branches from its hob's ⋯ menu in the
// quest's sheet. Aldric claims the docs folder of a repository for his quest and asks you a question;
// you take it over, and the sheet says the folder is yours. Once you answer, his write to the folder
// is refused while his write beside it goes through. The sheet also shows what the quest cost before
// any outcome is accepted. The hub's side is apps/server/test/claims.test.ts and
// packages/runtimes/test/taken-writes-contract.test.ts; the cost's division is
// packages/domain/test/quest-cost.test.ts. Taking over a hob's live browser waits for #382.

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd, stdio: "pipe" });

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
  mkdirSync(join(shared, "docs"));
  writeFileSync(join(shared, "docs", "README.md"), "# Docs\n");
  git(shared, "init", "-q", "-b", "main");
  git(shared, "add", ".");
  git(shared, "commit", "-q", "-m", "first");
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
});

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const TITLE = "Write the launch notes";

// covers OR-004, OR-006, OP-002, UX-001
test("[TC-UX-1449-05] takes over a hob's files from the quest's sheet, so its writes there are refused, and shows the quest's cost", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name: "Aldric",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4000,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      TITLE,
      script("start_quest", { key: "quest", goal: TITLE, acceptance: ["The notes name the launch date"] }),
      script("claim", { key: "docs", scope: "path", path: "docs" }),
      script("ask", {
        key: "go-on?",
        question: "Shall I write the notes?",
        options: [
          { label: "Write them", consequence: "Aldric writes the notes." },
          { label: "Wait", consequence: "Nothing is written." },
        ],
      }),
      // Your answer: Aldric writes in the folder you took over, then beside it.
      'fake:then fake:write docs/plan.md "The plan"',
      'fake:then fake:write notes.md "The notes"',
    ].join("\n"),
  );
  await composer.press("Enter");

  const asks = page.getByRole("region", { name: "Aldric asks you" }).last();
  await expect(asks).toContainText("Shall I write the notes?", { timeout: 30_000 });
  const sheet = await openQuest(page, TITLE);
  // Nothing is accepted yet, so the quest has no cost per outcome, only what it spent.
  const cost = sheet.getByRole("region", { name: "Cost" });
  await expect(cost).toContainText("No outcome accepted yet, so there is no cost per outcome.");
  await expect(cost).toContainText("tokens spent in");

  const lane = sheet.getByRole("region", { name: "Aldric's work" });
  await lane.getByRole("button", { name: "Aldric's task menu" }).click();
  const menu = page.getByRole("menu", { name: "Aldric's task" });
  await expect(menu).toContainText("Aldric keeps working, but Hobbots refuses its writes to them until the task ends.");
  await menu.getByRole("menuitem", { name: "Take over its files and branches" }).click();
  await expect(lane).toContainText("Yours now: docs. Hobbots refuses the hob's writes to them.");
  // Once taken over, there is nothing left to take.
  await lane.getByRole("button", { name: "Aldric's task menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Take over its files and branches" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expectAccessible(page, sheet);
  await page.keyboard.press("Escape");

  await asks.getByRole("button", { name: /^Write them/ }).click();
  // The write beside the folder goes through; the one inside it was refused before it ran.
  await expect.poll(() => existsSync(join(shared, "notes.md")), { timeout: 30_000 }).toBe(true);
  expect(existsSync(join(shared, "docs", "plan.md"))).toBe(false);
});
