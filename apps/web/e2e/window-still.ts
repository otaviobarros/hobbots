import { type BrowserContext, expect } from "@playwright/test";

/**
 * The window never scrolls: each panel scrolls inside it (#1026). The frame is at least 610px
 * tall, so a window shorter than that may scroll to show the rest, and is not checked.
 */
const FRAME_LEAST_HEIGHT = 610;

/**
 * Listens on every page of `context`, from before its own code runs, for the window scrolling or a
 * box that clips its overflow being scrolled to show what it hides, as a focus change or
 * `scrollIntoView` does. Each such move is recorded once, by where it happened.
 */
export const watchWindow = (context: BrowserContext) =>
  context.addInitScript((leastHeight) => {
    const moves = new Set<string>();
    (window as unknown as { __hobbotsMoves: Set<string> }).__hobbotsMoves = moves;
    const tall = () => {
      const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
      return window.innerHeight >= leastHeight * zoom;
    };
    const named = (element: Element) => {
      const slot = element.getAttribute("data-slot");
      const label = element.getAttribute("aria-label");
      return `<${element.tagName.toLowerCase()}${slot === null ? "" : ` data-slot="${slot}"`}${label === null ? "" : ` aria-label="${label}"`} class="${String(element.className).slice(0, 100)}">`;
    };
    document.addEventListener(
      "scroll",
      (event) => {
        if (document.getElementById("root") === null || !tall()) return;
        const target = event.target;
        if (target === document) {
          if (window.scrollX !== 0 || window.scrollY !== 0) {
            const root = document.documentElement;
            const past = [...document.querySelectorAll("body *")]
              .filter((element) => element.getBoundingClientRect().bottom + window.scrollY > root.clientHeight + 1)
              .filter((element) => {
                const parent = element.parentElement;
                return (
                  parent === null || parent.getBoundingClientRect().bottom + window.scrollY <= root.clientHeight + 1
                );
              })
              .slice(0, 5)
              .map((element) => named(element));
            moves.add(
              `the window was scrolled to ${window.scrollY}px of ${root.scrollHeight}px; past its bottom: ${past.join(", ")}`,
            );
          }
          return;
        }
        if (!(target instanceof Element)) return;
        const { overflowX, overflowY } = getComputedStyle(target);
        const clips = (overflow: string) => overflow === "hidden" || overflow === "clip";
        if ((clips(overflowY) && target.scrollTop !== 0) || (clips(overflowX) && target.scrollLeft !== 0))
          moves.add(`a box that clips its overflow was scrolled: ${named(target)}`);
      },
      true,
    );
  }, FRAME_LEAST_HEIGHT);

/**
 * What broke the rule on a page: each recorded move, and whether the window is taller than the
 * viewport now, naming what is placed past its bottom edge. Empty when the window stayed still.
 */
export const windowMoves = (page: import("@playwright/test").Page) =>
  page.evaluate((leastHeight) => {
    const recorded = (window as unknown as { __hobbotsMoves?: Set<string> }).__hobbotsMoves;
    const moves = [...(recorded ?? [])];
    // An absolutely placed element is placed in its nearest positioned box. When that box lies
    // outside the panel the element scrolls in, the element escapes the panel's scrolling and
    // stretches whatever does hold it, up to the window.
    const scrolls = (element: Element) => {
      const { overflowX, overflowY } = getComputedStyle(element);
      return /auto|scroll/.test(`${overflowX} ${overflowY}`);
    };
    const named = (element: Element) =>
      `<${element.tagName.toLowerCase()} class="${String(element.className).slice(0, 100)}">`;
    for (const element of document.querySelectorAll("#root *")) {
      // Only an HTML element has an offset parent; an SVG shape is placed inside its own drawing.
      if (!(element instanceof HTMLElement) || getComputedStyle(element).position !== "absolute") continue;
      let panel = element.parentElement;
      while (panel !== null && !scrolls(panel)) panel = panel.parentElement;
      const box = element.offsetParent;
      if (panel !== null && box !== null && !panel.contains(box))
        moves.push(`${named(element)} is placed outside the panel it scrolls in, ${named(panel)}`);
    }
    const root = document.scrollingElement;
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    if (document.getElementById("root") === null || root === null || window.innerHeight < leastHeight * zoom)
      return moves;
    if (root.scrollHeight > root.clientHeight) {
      const past = [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().bottom > root.clientHeight + 1)
        .filter((element) => {
          const parent = element.parentElement;
          return parent === null || parent.getBoundingClientRect().bottom <= root.clientHeight + 1;
        })
        .slice(0, 5)
        .map((element) => `<${element.tagName.toLowerCase()} class="${String(element.className).slice(0, 100)}">`);
      moves.push(
        `the window is ${root.scrollHeight}px tall in a ${root.clientHeight}px viewport; past its bottom: ${past.join(", ")}`,
      );
    }
    return moves;
  }, FRAME_LEAST_HEIGHT);

/** Fails when any page of `context` that is still open scrolled its window or was taller than it. */
export const expectWindowStill = async (context: BrowserContext) => {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const moves = await windowMoves(page).catch(() => []);
    expect(moves, `The window must never scroll (#1026) on ${page.url()}`).toEqual([]);
  }
};
