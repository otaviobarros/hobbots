import type { Locator, Page } from "@playwright/test";

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The ticket under the request with this title: one button, named by what it shows (the Quest,
 * where it stands, then Open quest), which stays there whether the work runs or has ended. It is
 * found while the quest's sheet covers the chat too, as the sheet hides the chat from assistive tech,
 * but never a copy the page keeps out of sight. Found that way, its name also holds the party's
 * sprites, so the title is not where it starts.
 */
export const ticket = (page: Page, title: string): Locator =>
  page
    .getByRole("button", { name: new RegExp(`${literal(title)}: .*Open quest`), includeHidden: true })
    .filter({ visible: true });

/**
 * Opens the quest from a ticket, then its Workbench beside the chat, and gives back the Workbench.
 * With the quest already open in the sheet, it goes on from there.
 */
export const openWorkbench = async (page: Page, from: Locator): Promise<Locator> => {
  if ((await page.getByRole("dialog").count()) === 0) await from.click();
  await page.getByRole("dialog").getByRole("button", { name: "Show the work" }).click();
  return page.getByRole("region", { name: /^Workbench for / });
};

/** A hob's work in the open quest. */
const lane = (page: Page, name: string): Locator => page.getByRole("region", { name: `${name}'s work`, exact: true });

/** One Task in the open quest, by its title, in the named hob's work when two Tasks share a title. */
export const laneTask = (page: Page, title: string, owner?: string): Locator =>
  (owner === undefined ? page.getByRole("dialog") : lane(page, owner)).getByRole("region", {
    name: title,
    exact: true,
  });
