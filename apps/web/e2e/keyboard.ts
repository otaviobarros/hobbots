import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Helpers for the keyboard-only flows (STD-TEST-008). They move and act with keys alone, as a
 * keyboard or screen-reader user does: no clicks, no `focus()`, no `fill()`.
 */

/** How many Tab presses a control may be away from the focus before the flow counts as broken. */
const MAX_TABS = 80;

const isFocused = (target: Locator) =>
  target.evaluate((element) => element === document.activeElement || element.contains(document.activeElement));

/**
 * Presses Tab (or Shift+Tab with `backwards`) until `target` has the focus, and fails when it is
 * out of reach: a control the Tab order skips is closed to keyboard users.
 */
export const tabTo = async (page: Page, target: Locator, { backwards = false } = {}) => {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < MAX_TABS; presses++) {
    if (await isFocused(target)) return;
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
  }
  if (await isFocused(target)) return;
  const focused = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? "nothing");
  throw new Error(`${MAX_TABS} presses of Tab never reached ${target}; the focus is on ${focused}`);
};

/** Tabs to `target` and presses `key` on it: Enter for links and buttons, Space for check boxes. */
export const press = async (page: Page, target: Locator, key = "Enter") => {
  await tabTo(page, target);
  await page.keyboard.press(key);
};

/** Tabs to a text field and types `text` into it, key by key. */
export const typeInto = async (page: Page, field: Locator, text: string) => {
  await tabTo(page, field);
  await page.keyboard.type(text);
};
