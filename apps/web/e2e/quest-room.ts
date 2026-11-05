import type { Locator, Page } from "@playwright/test";

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The ticket under the request with this title (ADR 027): one button, named for the Quest and where
 * it stands, which stays there whether the work runs or has ended.
 */
export const ticket = (page: Page, title: string): Locator =>
  page.getByRole("button", { name: new RegExp(`^Open the ${literal(title)} room: `) });

/** Opens a request's Quest room with its ticket in the chat, and gives back the room. */
export const openRoom = async (page: Page, title: string): Promise<Locator> => {
  await ticket(page, title).click();
  return questRoom(page, title);
};

/** Opens the Quest room from a ticket with the Workbench docked under the lanes, and gives back the dock. */
export const openWorkbench = async (page: Page, from: Locator): Promise<Locator> => {
  await from.click();
  await page.getByRole("button", { name: "Open the Workbench" }).click();
  return dock(page);
};

/** The Quest room of the request with this title, beside the chat. */
export const questRoom = (page: Page, title: string): Locator =>
  page.getByRole("region", { name: `${title}, Quest room` });

/** A hob's lane in the open room. */
export const lane = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name}'s lane`, exact: true });

/** One Task in its hob's lane, by its title, in the named hob's lane when two Tasks share a title. */
export const laneTask = (page: Page, title: string, owner?: string): Locator =>
  (owner === undefined ? page.getByRole("region", { name: "Lanes" }) : lane(page, owner)).getByRole("region", {
    name: title,
    exact: true,
  });

/** The Workbench docked under the lanes, named for the Task it shows. */
export const dock = (page: Page): Locator => page.getByRole("region", { name: /^Workbench for / });

/** Opens "Everything in this task" on a Task in its lane, and gives back the Task. */
export const taskDetails = async (page: Page, title: string, owner?: string): Promise<Locator> => {
  const task = laneTask(page, title, owner);
  const details = task.locator(":scope > details");
  if ((await details.getAttribute("open")) === null) await details.locator(":scope > summary").click();
  return task;
};

/**
 * What a Task did, as its lane's "Everything in this task" sums it up: what happened, what it made
 * and what is still open. Opens the details first.
 */
export const taskSummary = async (page: Page, title: string, owner?: string): Promise<Locator> =>
  (await taskDetails(page, title, owner)).locator('[data-slot="summary"]');

/**
 * Shows a Task's work in the Workbench docked under the lanes, on Changes, and gives back the dock.
 * The button sits in the Task's details, which this opens first.
 */
export const showInWorkbench = async (page: Page, title: string, owner?: string): Promise<Locator> => {
  await (await taskDetails(page, title, owner)).getByRole("button", { name: "Show in the Workbench" }).click();
  const bench = dock(page);
  await bench.getByRole("heading", { name: title }).waitFor();
  return bench;
};

/** A lane's header, which names its hob, its Task and the Task's state, and lights the lane. */
export const laneHead = (page: Page, name: string): Locator =>
  lane(page, name).getByRole("button", { name: `Show ${name}'s work in the Workbench` });

/** The room's ⋯ menu, opened. */
export const roomMenu = async (page: Page, title: string): Promise<void> => {
  await questRoom(page, title)
    .getByRole("button", { name: `${title} menu` })
    .click();
};

/** Opens the ⋯ menu on a hob's lane, and gives back the menu. */
export const laneMenu = async (page: Page, name: string): Promise<Locator> => {
  await lane(page, name)
    .getByRole("button", { name: `${name}'s task menu` })
    .click();
  return page.getByRole("menu", { name: `${name}'s task` });
};

/**
 * Cancels the Task a hob's lane names from its ⋯ menu, saying Yes to the question it asks in the
 * lane, and gives back the lane.
 */
export const cancelInLane = async (page: Page, name: string): Promise<Locator> => {
  const menu = await laneMenu(page, name);
  await menu.getByRole("menuitem", { name: "Cancel task…" }).click();
  const the = lane(page, name);
  await the.getByRole("button", { name: "Yes, cancel" }).click();
  return the;
};
