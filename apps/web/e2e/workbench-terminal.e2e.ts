import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-sheet.ts";
import { hobTerminal, rows } from "./terminal.ts";
import { FRAME_LEAST_HEIGHT } from "./window-still.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

/** Sends a message to Aldric and waits until his turn is underway. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
};

/** Waits for Aldric's turn to end. */
const settled = (page: Page) => expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

/** Opens the Task's Workbench from its ticket in the chat, on its Terminal. */
const openTerminal = async (page: Page, title: string) => {
  const questTicket = ticket(page, title);
  await openWorkbench(page, questTicket);
  const bench = page.getByRole("region", { name: `Workbench for ${title}` });
  await bench.getByRole("tab", { name: /^Terminal/ }).click();
  return { questTicket, bench, panel: bench.getByRole("tabpanel", { name: /^Terminal/ }) };
};

/**
 * How far the Terminal's dock panel is scrolled, and how far each box around the panel is, up to
 * the window.
 */
const scrolledAround = (panel: Locator) =>
  panel.evaluate((element) => {
    const scroller = element.parentElement;
    const offsets: Array<number> = [0];
    for (let box = scroller?.parentElement ?? null; box !== null; box = box.parentElement) offsets.push(box.scrollTop);
    return {
      panel: scroller?.scrollTop ?? 0,
      boxes: Math.max(...offsets),
      window: document.scrollingElement?.scrollTop ?? 0,
    };
  });

/** How far the terminal's rows run past the bottom of the box they are fitted to, in pixels. */
const rowsPast = (terminal: Locator) =>
  terminal.evaluate((element) => {
    const screen = element.querySelector('[data-slot="terminal-screen"]');
    const shown = element.querySelector(".xterm-screen");
    if (screen === null || shown === null) return Number.POSITIVE_INFINITY;
    return Math.round(shown.getBoundingClientRect().bottom - screen.getBoundingClientRect().bottom);
  });

// Issue #1002: the terminal took xterm.js's default 24 rows whatever the dock's height, ran past the
// dock and scrolled the panel, the room and the window to show its last row.
test("the Terminal fits the Workbench at any window height, and reading it scrolls nothing around it (#1002)", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await send(page, [
    "Count the lines",
    "fake:tool Bash seq 300",
    script("start_quest", { key: "quest", goal: "Count the lines" }),
    script("complete_task", { delivered: true, key: "done", summary: "Counted." }),
  ]);
  await settled(page);
  const { panel } = await openTerminal(page, "Count the lines");
  const terminal = hobTerminal(panel, "Aldric");
  await expect(rows(terminal)).toContainText("300");

  // In the dock's first height the terminal is shorter than its default 24 rows, and fits.
  const fits = async () => {
    await expect.poll(() => rowsPast(terminal)).toBeLessThanOrEqual(0);
    await expect.poll(() => panel.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    await expect(panel.getByRole("tab", { name: /^Aldric/ })).toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole("searchbox", { name: "Find in the terminal" })).toBeInViewport({ ratio: 1 });
  };
  await fits();
  const shownRows = () => terminal.locator(".xterm-rows > div").count();
  const docked = await shownRows();
  expect(docked).toBeLessThan(24);

  // Reading it to its last row, by the mouse and by the keyboard, scrolls nothing around it.
  await terminal.locator(".xterm-screen").click();
  await terminal.locator(".xterm-accessibility-tree > div").last().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect.poll(() => scrolledAround(panel)).toEqual({ panel: 0, boxes: 0, window: 0 });
  await expect(page.getByRole("button", { name: "Close the quest" })).toBeInViewport();

  // The shortest window the frame fits still holds the terminal's tabs, Find and a couple of rows,
  // with nothing scrolled. A shorter one scrolls by design to show the rest of the frame (STD-TEST-010).
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: FRAME_LEAST_HEIGHT });
  await expect.poll(shownRows).toBeLessThan(docked);
  await expect.poll(shownRows).toBeGreaterThanOrEqual(2);
  await fits();
  await terminal.locator(".xterm-accessibility-tree > div").last().focus();
  await page.keyboard.press("End");
  await expect.poll(() => scrolledAround(panel)).toEqual({ panel: 0, boxes: 0, window: 0 });
});
