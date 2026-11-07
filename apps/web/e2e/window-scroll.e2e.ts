import type { Locator, Page } from "@playwright/test";
import { SETTINGS_SECTIONS } from "../src/components/settings/sections.ts";
import type { SetAside } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-room.ts";
import type { WindowWatch } from "./window-still.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1026: in a long chat the whole window scrolled, leaving the composer at the top of the
// window over an empty area. Screen-reader labels inside the transcript escaped its scrolling and
// stretched the window to the transcript's height, so the wheel past the transcript's end, or a
// focus change, moved the whole frame. The chat here holds far more than fits; on it and on every
// other screen the window stays put however it is scrolled, and each screen passes the accessibility scan. The shared fixture checks every other
// test the same way (STD-TEST-010).

test.afterEach(stopAldricHub);

/** Sends a message to Aldric and waits until his turn has ended. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

/**
 * Known violations a screen's scan leaves out until their issue decides the fix. A hob card on
 * Your hobs is named by its name and state, not by everything it shows, which axe reads as a
 * label that does not match its content (WCAG 2.5.3).
 */
const SET_ASIDE: Readonly<Record<string, SetAside>> = {
  "/hobs": { selector: "a.hop-on-hover.cut", issue: "#839" },
};

/**
 * Tries every way to scroll the window: the wheel over the middle of the screen, far past the end
 * of whatever panel is there and back, and scrolling the window itself. None of it may move it.
 */
const expectStill = async (
  page: Page,
  watch: WindowWatch,
  scan: (within?: Locator, setAside?: SetAside) => Promise<void>,
  where: string,
) => {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(width / 2, height / 2);
  for (let turn = 0; turn < 3; turn++) await page.mouse.wheel(0, 4000);
  await page.evaluate(() => window.scrollTo(0, 100_000));
  await expect.poll(() => page.evaluate(() => window.scrollY), { message: `${where}: the window scrolled` }).toBe(0);
  for (let turn = 0; turn < 3; turn++) await page.mouse.wheel(0, -4000);
  await watch.check(page);
  expect(watch.breaks(), `${where}: the window must never scroll`).toEqual([]);
  // Each screen it visits is also checked for accessibility (STD-TEST-007).
  await test.step(`scan ${where}`, () => scan(undefined, SET_ASIDE[where]));
};

// covers UX-001, UX-006, #1026
test("[TC-UX-1026-01] a long chat, its Quest room and Workbench, and every other screen never scroll the window", async ({
  page,
  windowStill,
  scan,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // Enough steps, each marked for screen readers, to run the transcript well past the window.
  const steps = Array.from({ length: 24 }, (_, index) => `fake:tool Bash echo step ${index + 1}`);
  await send(page, [
    "Walk through the steps",
    ...steps,
    script("start_quest", { key: "quest", goal: "Walk through the steps" }),
    script("complete_task", { delivered: true, key: "done", summary: "Walked through them." }),
  ]);
  // A long message of its own lines, after more marked steps.
  await send(page, [
    "And once more",
    ...Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the notes`),
    ...steps,
  ]);

  // The transcript holds more than the window, and scrolls inside it.
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  const firstSteps = page.getByRole("list", { name: "Reply steps" }).first();
  /** How far the panel the transcript scrolls in runs past what it shows, after scrolling it to `top`. */
  const transcript = (top?: number) =>
    firstSteps.evaluate((element, to) => {
      let panel = element.parentElement;
      while (panel !== null && getComputedStyle(panel).overflowY !== "auto") panel = panel.parentElement;
      if (panel === null) return 0;
      if (to !== undefined) panel.scrollTo(0, to);
      return panel.scrollHeight - panel.clientHeight;
    }, top);
  await expect.poll(() => transcript()).toBeGreaterThan(page.viewportSize()?.height ?? 720);
  await expectStill(page, windowStill, scan, "the chat");
  // Reading back to the top and returning to the composer still moves only the transcript.
  await transcript(0);
  await composer.focus();
  await expect(composer).toBeInViewport();
  await expectStill(page, windowStill, scan, "the chat, back at the composer");

  // The room beside the chat, then its Workbench on each tab the Task used.
  const bench = await openWorkbench(page, ticket(page, "Walk through the steps"));
  await expectStill(page, windowStill, scan, "the Quest room");
  for (const tab of ["Changes", "Files", "Terminal"]) {
    const opens = bench.getByRole("tab", { name: new RegExp(`^${tab}`) });
    // A tab the Task left empty is greyed out and cannot open.
    if (!(await opens.isEnabled())) continue;
    await opens.click();
    await expectStill(page, windowStill, scan, `the Workbench's ${tab}`);
  }

  // Every other screen.
  const screens = [
    "/",
    "/hobs",
    `/hobs/${aldric}`,
    `/hobs/${aldric}/profile`,
    "/inbox",
    "/usage",
    "/memory",
    "/archive",
    "/summon",
    ...SETTINGS_SECTIONS.map((section) => `/settings/${section}`),
  ];
  for (const screen of screens) {
    await page.goto(`${url}/#${screen}`);
    await expect(page.getByRole("main").first()).toBeVisible();
    await expectStill(page, windowStill, scan, screen);
  }
});
