import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, laneTask, openRoom, questRoom, ticket } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(async () => {
  await stopQuestHub();
  await stopAldricHub();
});

/** The sprites on a ticket, one per hob on the Quest up to the most it has room for. */
const sprites = (on: Locator) =>
  on
    .locator("span[aria-hidden]")
    .first()
    .locator(":scope > span")
    .filter({ has: on.page().locator("[aria-hidden]") });

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
  await expect(quest).toHaveAccessibleName(/^Plan the Black Friday campaign: \d of 2 done/);
  await expect(sprites(quest)).toHaveCount(3);
  await expect(quest).toContainText("Open room");
  const tall = await height(quest);

  // Ada's question reaches you: the ticket says so, and stays the same size.
  await expect(quest).toContainText("1 needs you", { timeout: 15_000 });
  await expect(quest).toHaveAccessibleName(/of 2 done, 1 needs you\. Open room$/);
  expect(await height(quest)).toBe(tall);

  // Your answer goes back, the tag leaves, and once the Quest finishes the ticket says how it ended.
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(quest).not.toContainText("needs you");
  await expect(quest).toContainText("Finished in", { timeout: 30_000 });
  await expect(quest).toHaveAccessibleName(/^Plan the Black Friday campaign: Finished in /);
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
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  const second = ticket(page, "Write the summary");
  await expect(second).toBeVisible({ timeout: 20_000 });
  await expect(second).toContainText("Started");
  await expect(first).toContainText("Finished in");

  // Each ticket sits under the request that started it, in the order you sent them, once the turn
  // has settled. The order is read from the page in one go, so a scroll between reads cannot skew it.
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  const chat = page.getByRole("main", { name: "Chat" });
  const order = () =>
    chat.evaluate((root) => {
      const marks = [...root.querySelectorAll("*")].flatMap((each) => {
        const ticket = each.tagName === "BUTTON" ? (each.textContent ?? "") : "";
        const text = each.childElementCount === 0 ? (each.textContent ?? "") : "";
        if (ticket.startsWith("Tidy the notes: ")) return ["ticket 1"];
        if (ticket.startsWith("Write the summary: ")) return ["ticket 2"];
        if (text.startsWith("Tidy the notes\nfake:hub start_quest")) return ["request 1"];
        if (text.startsWith("Write the summary\nfake:hub start_quest")) return ["request 2"];
        return [];
      });
      return marks;
    });
  await expect.poll(order).toEqual(["request 1", "ticket 1", "request 2", "ticket 2"]);

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
  await expect(done).toHaveAccessibleName(/^Tidy the notes: Finished in \S+/, { timeout: 30_000 });
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

/** The duration a finished ticket and the room's finish banner each show. */
const durations = async (page: Page, title: string) => {
  const name = (await ticket(page, title).textContent()) ?? "";
  const meta =
    (await questRoom(page, title)
      .getByRole("region", { name: /^(Quest|Task) finished$/ })
      .textContent()) ?? "";
  return { ticket: /Finished in (.+?)(?:, |\. Open room)/.exec(name)?.[1], banner: /took (.+?)( ·|$)/.exec(meta)?.[1] };
};

// covers UX-002, UX-006
test("[TC-UX-224] a finished Quest's ticket and finish banner show one duration, which a reload after its lead's turn ends keeps (#1007)", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // The reply streams its words after complete_task, so the lead's turn ends seconds after the Quest.
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { key: "done", summary: "The notes are tidy." }),
      Array.from({ length: 120 }, (_, index) => `word${index}`).join(" "),
    ].join("\n"),
  );
  await composer.press("Enter");
  const done = ticket(page, "Tidy the notes");
  await expect(done).toHaveAccessibleName(/Finished in /, { timeout: 30_000 });
  await openRoom(page, "Tidy the notes");
  const live = await durations(page, "Tidy the notes");
  expect(live.ticket).toBeDefined();
  expect(live.banner).toBe(live.ticket);
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // Once the turn has ended, a reload reads the same duration in both places.
  await page.reload();
  await expect(done).toHaveAccessibleName(/Finished in /);
  await expect(questRoom(page, "Tidy the notes").getByRole("region", { name: /finished$/ })).toContainText("took ");
  expect(await durations(page, "Tidy the notes")).toEqual(live);
});

/** Fails unless `inner` lies inside `outer`'s left and right edges, and has some width of its own. */
const expectWithin = async (inner: Locator, outer: Locator) => {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  if (a === null || b === null) throw new Error("Both elements need a box.");
  expect(a.width).toBeGreaterThan(0);
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
};

// covers UX-001, UX-002
test("[TC-UX-223] at 1024 wide, beside the room, a party of five's ticket keeps its title, its state, what needs you and its way in readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { url, aldric } = await questHub({ nested: true });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const title = "Plan the Black Friday campaign";
  const quest = ticket(page, title);
  await expect(quest).toContainText("1 needs you", { timeout: 15_000 });

  // With the room open, the chat is a 300 px column: the title and the arrow take the first line,
  // and two sprites, how many more, the progress and the needs-you tag the second, all inside it.
  await openRoom(page, title);
  const chat = page.getByRole("main", { name: "Chat" });
  await expect(quest).toHaveAccessibleName(/of \d+ done, 1 needs you\. Open room$/);
  await expect(sprites(quest).filter({ visible: true })).toHaveCount(2);
  await expect(quest.getByText("+3", { exact: true })).toBeVisible();
  // Each part ends in the words a screen reader hears after it, so it is found by what it starts with.
  for (const part of [
    quest.getByText(title),
    quest.getByText(/of \d+ done/),
    quest.getByText("1 needs you"),
    quest.getByText("→", { exact: true }),
  ]) {
    await expect(part).toBeVisible();
    await expectWithin(part, chat);
  }
  expect((await quest.getByText(title).boundingBox())?.width ?? 0).toBeGreaterThan(140);

  // In the chat's full width it is one line again, with four sprites and Open room in words.
  await questRoom(page, title).getByRole("button", { name: "Close room" }).click();
  await expect(quest.getByText("+1", { exact: true })).toBeVisible();
  await expect(quest.getByText("Open room")).toBeVisible();
  const line = await quest.getByText(title).boundingBox();
  const state = await quest.getByText("1 needs you").boundingBox();
  expect(Math.abs((line?.y ?? 0) - (state?.y ?? 100))).toBeLessThan(12);
});
