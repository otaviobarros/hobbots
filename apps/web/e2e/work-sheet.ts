import type { Locator, Page } from "@playwright/test";

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Opens a request's quest sheet with Show all on its card in the chat, which stays there whether the
 * work runs or has ended, and gives back the sheet.
 */
export const openQuest = async (page: Page, title: string): Promise<Locator> => {
  await page
    .getByRole("region", { name: new RegExp(`'s work on ${literal(title)}$`) })
    .getByRole("button", { name: "Show all" })
    .click();
  return questSheet(page, title);
};

/** The quest sheet of the request with this title. */
export const questSheet = (page: Page, title: string): Locator => page.getByRole("dialog", { name: `${title}, quest` });

/** The task sheet of the Task with this title. */
export const taskSheet = (page: Page, title: string): Locator =>
  page.getByRole("dialog", { name: `${title}, task details` });
