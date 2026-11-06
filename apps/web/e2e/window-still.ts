import type { BrowserContext, Page } from "@playwright/test";

/**
 * The window never scrolls: each panel scrolls inside it (#1026, STD-TEST-010). The frame is at
 * least 610px tall, so a window shorter than that may scroll to show the rest, and its scrolling and
 * height are not checked. An element placed outside the panel it scrolls in is wrong at any size.
 */
const FRAME_LEAST_HEIGHT = 610;

/** The name the page reports each break of the rule by, kept by the test, outside the page. */
const REPORT = "__hobbotsWindowBroke";

/** What the page itself exposes: a check of its layout now, which resolves once reported. */
interface Watched {
  readonly __hobbotsCheckWindow?: () => Promise<void>;
}

/**
 * Watches the window of every page `context` opens, from before the page's own code runs. The page
 * checks its layout once loaded, as it changes (at most every quarter second), whenever anything
 * scrolls, and as it is left: whether the window is scrolled or taller than the viewport, whether a box that clips
 * its overflow was scrolled to show what it hides (as a focus change or `scrollIntoView` does), and
 * whether an absolutely placed element sits outside the panel it scrolls in. Each break is reported
 * to the test as it happens, so a later navigation or reload cannot take it back.
 */
export const watchWindow = async (context: BrowserContext) => {
  const breaks = new Set<string>();
  await context.exposeBinding(REPORT, ({ page }, found: string) => {
    breaks.add(`${found} (on ${page.url()})`);
  });
  await context.addInitScript(
    ({ leastHeight, report }) => {
      const send = (window as unknown as Record<string, (found: string) => Promise<void>>)[report];
      const sent = new Set<string>();
      const tell = (found: string) => {
        if (sent.has(found)) return Promise.resolve();
        sent.add(found);
        return send?.(found) ?? Promise.resolve();
      };
      const tall = () => {
        const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
        return window.innerHeight >= leastHeight * zoom;
      };
      const named = (element: Element) => {
        const slot = element.getAttribute("data-slot");
        const label = element.getAttribute("aria-label");
        return `<${element.tagName.toLowerCase()}${slot === null ? "" : ` data-slot="${slot}"`}${label === null ? "" : ` aria-label="${label}"`} class="${String(element.className).slice(0, 100)}">`;
      };
      const scrolls = (element: Element) => {
        const { overflowX, overflowY } = getComputedStyle(element);
        return /auto|scroll/.test(`${overflowX} ${overflowY}`);
      };
      // An absolutely placed element is placed in its nearest positioned box. When that box lies
      // outside the panel the element scrolls in, the element escapes the panel's scrolling and
      // stretches whatever does hold it, up to the window.
      const escapes = () => {
        const found: Array<string> = [];
        for (const element of document.querySelectorAll("#root *")) {
          // Only an HTML element has an offset parent; an SVG shape is placed inside its own drawing.
          if (!(element instanceof HTMLElement) || getComputedStyle(element).position !== "absolute") continue;
          let panel = element.parentElement;
          while (panel !== null && !scrolls(panel)) panel = panel.parentElement;
          const box = element.offsetParent;
          if (panel !== null && box !== null && !panel.contains(box))
            found.push(`${named(element)} is placed outside the panel it scrolls in, ${named(panel)}`);
        }
        return found;
      };
      const pastBottom = (root: Element) =>
        [...document.querySelectorAll("body *")]
          .filter((element) => element.getBoundingClientRect().bottom + window.scrollY > root.clientHeight + 1)
          .filter((element) => {
            const parent = element.parentElement;
            return parent === null || parent.getBoundingClientRect().bottom + window.scrollY <= root.clientHeight + 1;
          })
          .slice(0, 5)
          .map(named)
          .join(", ");
      const check = () => {
        const root = document.scrollingElement;
        if (document.getElementById("root") === null || root === null) return Promise.resolve();
        const found = escapes();
        if (tall()) {
          if (window.scrollX !== 0 || window.scrollY !== 0)
            found.push(`the window was scrolled to ${window.scrollY}px; past its bottom: ${pastBottom(root)}`);
          if (root.scrollHeight > root.clientHeight)
            found.push(
              `the window is ${root.scrollHeight}px tall in a ${root.clientHeight}px viewport; past its bottom: ${pastBottom(root)}`,
            );
        }
        return Promise.all(found.map(tell)).then(() => undefined);
      };
      (window as unknown as Watched & { __hobbotsCheckWindow: () => Promise<void> }).__hobbotsCheckWindow = check;

      // Checked at most every quarter second while the page changes, so a long stream of changes
      // is still checked as it goes.
      let pending: ReturnType<typeof setTimeout> | undefined;
      const soon = () => {
        if (pending !== undefined) return;
        pending = setTimeout(() => {
          pending = undefined;
          void check();
        }, 250);
      };
      document.addEventListener(
        "scroll",
        (event) => {
          if (document.getElementById("root") === null) return;
          const target = event.target;
          if (target === document) {
            void check();
            return;
          }
          // A text field scrolls its own text as you type, which moves nothing around it.
          if (!(target instanceof Element) || target.matches("input, textarea, select") || !tall()) return;
          const { overflowX, overflowY } = getComputedStyle(target);
          const clips = (overflow: string) => overflow === "hidden" || overflow === "clip";
          if ((clips(overflowY) && target.scrollTop !== 0) || (clips(overflowX) && target.scrollLeft !== 0))
            void tell(`a box that clips its overflow was scrolled: ${named(target)}`);
        },
        true,
      );
      const observe = () => {
        new MutationObserver(soon).observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
        });
        new ResizeObserver(soon).observe(document.documentElement);
        soon();
      };
      if (document.documentElement === null) document.addEventListener("DOMContentLoaded", observe, { once: true });
      else observe();
      // Once the page has loaded, and as it is left, so a page left at once is still checked.
      window.addEventListener("load", () => void check());
      window.addEventListener("pagehide", () => void check());
    },
    { leastHeight: FRAME_LEAST_HEIGHT, report: REPORT },
  );

  return {
    /** Every break reported so far, on any page, each once. */
    breaks: (): ReadonlyArray<string> => [...breaks],
    /** Forgets the breaks reported so far, for a test that breaks the rule on purpose. */
    forget: () => breaks.clear(),
    /** Checks `page` as it is now, and waits until what it found is reported. */
    check: (page: Page) => page.evaluate(() => (window as Watched).__hobbotsCheckWindow?.()),
    /**
     * Checks each page still open. A page that closes meanwhile has nothing left to check; any other
     * failure to check fails the test, so a broken check never passes for a still window.
     */
    checkOpenPages: async () => {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        try {
          await page.evaluate(() => (window as Watched).__hobbotsCheckWindow?.());
        } catch (error) {
          if (!page.isClosed()) throw error;
        }
      }
    },
  };
};

export type WindowWatch = Awaited<ReturnType<typeof watchWindow>>;
