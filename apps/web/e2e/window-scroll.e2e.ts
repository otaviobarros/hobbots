import type { Page } from "@playwright/test";
import { SETTINGS_SECTIONS } from "../src/components/settings/sections.ts";
import { expect, test } from "./hub.ts";
import { openWorkbench, ticket } from "./quest-room.ts";
import { windowMoves } from "./window-still.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1026: in a long chat the whole window scrolled, leaving the composer at the top of the
// window over an empty area. Screen-reader labels inside the transcript escaped its scrolling and
// stretched the window to the transcript's height, so the wheel past the transcript's end, or a
// focus change, moved the whole frame. Each screen here holds more than fits, and the window stays
// put however it is scrolled. The shared fixture checks the same on every other test (STD-TEST-010).

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
 * Tries every way to scroll the window: the wheel over the middle of the screen, far past the end
 * of whatever panel is there and back, and scrolling the window itself. None of it may move it.
 */
const expectStill = async (page: Page, where: string) => {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(width / 2, height / 2);
  for (let turn = 0; turn < 3; turn++) await page.mouse.wheel(0, 4000);
  await page.evaluate(() => window.scrollTo(0, 100_000));
  await expect.poll(() => page.evaluate(() => window.scrollY), { message: `${where}: the window scrolled` }).toBe(0);
  for (let turn = 0; turn < 3; turn++) await page.mouse.wheel(0, -4000);
  expect(await windowMoves(page), `${where}: the window must never scroll`).toEqual([]);
};

// covers UX-001, UX-006, #1026
test("[TC-UX-1026-01] a long chat, its Quest room and Workbench, and every other screen never scroll the window", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  // Enough steps, each marked for screen readers, to run the transcript well past the window.
  const steps = Array.from({ length: 24 }, (_, index) => `fake:tool Bash echo step ${index + 1}`);
  await send(page, [
    "Walk through the steps",
    ...steps,
    script("start_quest", { key: "quest", goal: "Walk through the steps" }),
    script("complete_task", { key: "done", summary: "Walked through them." }),
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
  await expectStill(page, "the chat");
  // Reading back to the top and returning to the composer still moves only the transcript.
  await transcript(0);
  await composer.focus();
  await expect(composer).toBeInViewport();
  await expectStill(page, "the chat, back at the composer");

  // The room beside the chat, then its Workbench on each tab.
  const bench = await openWorkbench(page, ticket(page, "Walk through the steps"));
  await expectStill(page, "the Quest room");
  for (const tab of ["Changes", "Files", "Terminal"]) {
    const opens = bench.getByRole("tab", { name: new RegExp(`^${tab}`) });
    // A tab the Task left empty is greyed out and cannot open.
    if (!(await opens.isEnabled())) continue;
    await opens.click();
    await expectStill(page, `the Workbench's ${tab}`);
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
    await expectStill(page, screen);
  }
});
