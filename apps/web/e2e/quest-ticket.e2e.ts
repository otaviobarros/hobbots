import type { Locator } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, laneTask, openRoom, questRoom, ticket } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(async () => {
  await stopQuestHub();
  await stopAldricHub();
});

/** The sprites on a ticket, one per hob on the Quest. */
const sprites = (on: Locator) => on.locator(":scope > span").first().locator(":scope > span");

/** The ticket's height, which never changes however the work goes. */
const height = async (on: Locator) => (await on.boundingBox())?.height ?? 0;

// covers UX-002, UX-006, OR-001, OR-004
test("[TC-UX-220] a Quest's ticket stays one line under the request and follows it live as Tasks wait, need you and finish", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  // One button, named for the Quest and where it stands, with the party's sprites and Open room.
  const title = "Plan the Black Friday campaign";
  const quest = ticket(page, title);
  await expect(quest).toHaveAccessibleName(/^Open the Plan the Black Friday campaign room: \d of 2 done/);
  await expect(sprites(quest)).toHaveCount(3);
  await expect(quest).toContainText("Open room");
  const tall = await height(quest);

  // Ada's question reaches you: the ticket says so, and stays the same size.
  await expect(quest).toContainText("1 needs you", { timeout: 15_000 });
  await expect(quest).toHaveAccessibleName(/of 2 done, 1 needs you$/);
  expect(await height(quest)).toBe(tall);

  // Your answer goes back, the tag leaves, and once the Quest finishes the ticket says how it ended.
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(quest).not.toContainText("needs you");
  await expect(quest).toContainText("Finished in", { timeout: 30_000 });
  await expect(quest).toHaveAccessibleName(/^Open the Plan the Black Friday campaign room: Finished in /);
  expect(await height(quest)).toBe(tall);

  // The ticket is the only thing the request leaves in the chat: no Task rows, no Workbench button.
  const chat = page.getByRole("main", { name: "Chat" });
  await expect(chat.getByRole("button", { name: /^Look inside/ })).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Open in Workbench" })).toHaveCount(0);
});

// covers UX-002, OR-001
test("[TC-UX-221] two Quests in one thread each keep their own ticket under the message that started them, and their own quest button", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  const first = ticket(page, "Tidy the notes");
  await expect(first).toContainText("Finished in", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // A second request in the same thread starts a Quest of its own, which keeps running.
  await composer.fill(
    ["Write the summary", script("start_quest", { key: "quest", goal: "Write the summary" })].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  const second = ticket(page, "Write the summary");
  await expect(second).toBeVisible({ timeout: 20_000 });
  await expect(second).toContainText("Started");
  await expect(first).toContainText("Finished in");

  // Each ticket sits under the request that started it, in the order you sent them.
  const chat = page.getByRole("main", { name: "Chat" });
  const asked = (title: string) => chat.getByText(new RegExp(`^${title}\\nfake:hub start_quest`));
  const tops = await Promise.all(
    [asked("Tidy the notes"), first, asked("Write the summary"), second].map(
      async (each) => (await each.boundingBox())?.y ?? 0,
    ),
  );
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);

  // The running Quest has its own quest button in the header; the ended one leaves it.
  const strip = page.getByRole("region", { name: "Work in progress" });
  await expect(strip.getByRole("button", { name: /^Write the summary/ })).toBeVisible();
  await expect(strip.getByRole("button", { name: /^Tidy the notes/ })).toHaveCount(0);

  // Each ticket opens its own room.
  await second.click();
  await expect(questRoom(page, "Write the summary")).toBeVisible();
  await first.click();
  await expect(questRoom(page, "Tidy the notes")).toBeVisible();
  await expect(questRoom(page, "Write the summary")).toBeHidden();
});

// covers UX-002, UX-006
test("[TC-UX-222] a finished Quest's ticket says how it ended, needs nothing from you, and still opens its recap after a reload", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  const done = ticket(page, "Tidy the notes");
  await expect(done).toHaveAccessibleName(/^Open the Tidy the notes room: Finished in \S+/, { timeout: 30_000 });
  await expect(done).not.toContainText("needs you");
  await expect(sprites(done)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // After a reload it still says how it ended, and opens the room as a recap with Aldric's result.
  await page.reload();
  await expect(done).toContainText("Finished in");
  await openRoom(page, "Tidy the notes");
  await expect(lane(page, "Aldric")).toBeVisible();
  await expect(laneTask(page, "Tidy the notes", "Aldric")).toContainText("The notes are tidy.");
});
