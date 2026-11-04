import type { Locator, Page } from "@playwright/test";

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Opens a request's Quest room with Open room on its card in the chat, which stays there whether the
 * work runs or has ended, and gives back the room.
 */
export const openRoom = async (page: Page, title: string): Promise<Locator> => {
  await page
    .getByRole("region", { name: new RegExp(`'s work on ${literal(title)}$`) })
    .getByRole("button", { name: "Open room" })
    .click();
  return questRoom(page, title);
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

/** Shows a Task's work in the Workbench docked under the lanes, on Summary, and gives back the dock. */
export const showInWorkbench = async (page: Page, title: string, owner?: string): Promise<Locator> => {
  await laneTask(page, title, owner).getByRole("button", { name: "Show in the Workbench" }).click();
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
