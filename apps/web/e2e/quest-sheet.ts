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

/** Opens a request's quest in the chat's sheet with its ticket, and gives back the sheet. */
export const openQuest = async (page: Page, title: string): Promise<Locator> => {
  // A sheet already open covers the chat, so it closes first.
  if ((await page.getByRole("dialog").count()) > 0) await page.keyboard.press("Escape");
  await ticket(page, title).click();
  return questSheet(page, title);
};

/**
 * Opens the quest from a ticket, then its Workbench beside the chat, and gives back the Workbench.
 * With the quest already open in the sheet, it goes on from there.
 */
export const openWorkbench = async (page: Page, from: Locator): Promise<Locator> => {
  if ((await page.getByRole("dialog").count()) === 0) await from.click();
  await page.getByRole("dialog").getByRole("button", { name: "Show the work" }).click();
  return dock(page);
};

/** The quest with this title, open in the chat's sheet (ADR 037). */
export const questSheet = (page: Page, title: string): Locator => page.getByRole("dialog", { name: title });

/**
 * Goes back from the quest's Workbench to the quest in the sheet, as its Back to the quest does;
 * with the sheet already open, does nothing.
 */
const backToQuest = async (page: Page): Promise<void> => {
  const back = page.getByRole("button", { name: "Back to the quest" });
  if ((await page.getByRole("dialog").count()) === 0 && (await back.count()) > 0) await back.click();
  await page.getByRole("dialog").waitFor();
};

/** A hob's work in the open quest. */
export const lane = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name}'s work`, exact: true });

/** One Task in the open quest, by its title, in the named hob's work when two Tasks share a title. */
export const laneTask = (page: Page, title: string, owner?: string): Locator =>
  (owner === undefined ? page.getByRole("dialog") : lane(page, owner)).getByRole("region", {
    name: title,
    exact: true,
  });

/** The quest's Workbench beside the chat, named for the quest it shows. */
export const dock = (page: Page): Locator => page.getByRole("region", { name: /^Workbench for / });

/** Opens "Everything in this task" on a Task in the open quest, and gives back the Task. */
export const taskDetails = async (page: Page, title: string, owner?: string): Promise<Locator> => {
  await backToQuest(page);
  const task = laneTask(page, title, owner);
  const details = task.locator(":scope > details");
  if ((await details.getAttribute("open")) === null) await details.locator(":scope > summary").click();
  return task;
};

/**
 * What a Task did, as its "Everything in this task" sums it up: what happened, what it made and what
 * is still open. Opens the details first.
 */
export const taskSummary = async (page: Page, title: string, owner?: string): Promise<Locator> =>
  (await taskDetails(page, title, owner)).locator('[data-slot="summary"]');

/**
 * Shows a Task's work in the Workbench beside the chat, on Changes, and gives back the Workbench.
 * The button sits in the Task's details, which this opens first.
 */
export const showInWorkbench = async (page: Page, title: string, owner?: string): Promise<Locator> => {
  await (await taskDetails(page, title, owner)).getByRole("button", { name: "Show in the Workbench" }).click();
  const bench = dock(page);
  await bench.getByRole("heading", { name: title }).waitFor();
  return bench;
};

/**
 * The header over a hob's work, which names the hob, its role and where its Task stands, and shows
 * its work in the Workbench.
 */
export const laneHead = (page: Page, name: string): Locator =>
  lane(page, name).getByRole("button", { name: new RegExp(`Show ${literal(name)}'s work in the Workbench$`) });

/** Shows a hob's work in the Workbench from the quest, going back to the quest first if need be. */
export const showHob = async (page: Page, name: string): Promise<Locator> => {
  await backToQuest(page);
  await laneHead(page, name).click();
  return dock(page);
};

/** The quest's ⋯ menu, opened. */
export const questMenu = async (page: Page, title: string): Promise<void> => {
  await questSheet(page, title)
    .getByRole("button", { name: `${title} menu` })
    .click();
};

/** Opens the ⋯ menu on a hob's work, and gives back the menu. */
export const laneMenu = async (page: Page, name: string): Promise<Locator> => {
  await backToQuest(page);
  await lane(page, name)
    .getByRole("button", { name: `${name}'s task menu` })
    .click();
  return page.getByRole("menu", { name: `${name}'s task` });
};

/**
 * Cancels the Task a hob's work names from its ⋯ menu, saying Yes to the question it asks there,
 * and gives back the hob's work.
 */
export const cancelInLane = async (page: Page, name: string): Promise<Locator> => {
  const menu = await laneMenu(page, name);
  await menu.getByRole("menuitem", { name: "Cancel task…" }).click();
  const the = lane(page, name);
  await the.getByRole("button", { name: "Yes, cancel" }).click();
  return the;
};
