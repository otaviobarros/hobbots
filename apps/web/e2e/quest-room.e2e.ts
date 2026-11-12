import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { dock, lane, laneHead, laneTask, openRoom, questRoom, ticket } from "./quest-room.ts";

test.afterEach(stopQuestHub);

const TITLE = "Plan the Black Friday campaign";

/** Starts the Black Friday Quest from Aldric's fresh page and waits for its ticket. */
const startQuest = async (page: Page, url: string, aldric: string) => {
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(ticket(page, TITLE)).toBeVisible();
  return composer;
};

/** The chat beside the room. */
const chat = (page: Page) => page.getByRole("main", { name: "Chat" });

// covers UX-002, UX-006, OR-001
test("[TC-UX-201] the ticket, the header's quest button and the Inbox each open the room beside the chat, and Close room returns to the chat in place", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  const composer = await startQuest(page, url, aldric);

  // The ticket opens the room beside the chat, with focus on its title and a lane per hob.
  const room = await openRoom(page, TITLE);
  await expect(room.getByRole("heading", { name: TITLE })).toBeFocused();
  await expect(room).toContainText("Aldric's quest");
  for (const name of ["Aldric", "Quill", "Ada"]) await expect(lane(page, name)).toBeVisible();
  await expect(chat(page)).toBeVisible();
  await expect(page).toHaveURL(/\?room=/);

  // What you type in the chat beside the room stays when the room closes; focus goes back to it.
  await composer.fill("Keep the headlines short");
  await room.getByRole("button", { name: "Close room" }).click();
  await expect(room).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Keep the headlines short");
  expect(new URL(page.url()).hash).not.toContain("room=");

  // The header's quest button opens the same room.
  await page
    .getByRole("region", { name: "Work in progress" })
    .getByRole("button", { name: new RegExp(`^${TITLE}`) })
    .click();
  await expect(questRoom(page, TITLE)).toBeVisible();
  await expect(composer).toHaveValue("Keep the headlines short");

  // A lane lit from the lineup is in the address, so a reload brings back the same room.
  await room.getByRole("button", { name: "Go to Quill's lane" }).click();
  await expect(room.getByRole("button", { name: "Go to Quill's lane" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/lane=/);
  await room.getByRole("tab", { name: /Changes/ }).click();
  await expect(dock(page).getByRole("heading", { name: "Draft the landing copy" })).toBeVisible();
  await page.reload();
  await expect(questRoom(page, TITLE)).toBeVisible();
  await expect(room.getByRole("button", { name: "Go to Quill's lane" })).toHaveAttribute("aria-pressed", "true");
  await expect(dock(page).getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");

  // A question in the Inbox opens the room with the asking hob's lane lit.
  await page.goto(`${url}/#/inbox?tab=needs`);
  await page
    .getByRole("article", { name: "Question from Ada" })
    .getByRole("link", { name: "Open in the Quest room" })
    .click();
  await expect(questRoom(page, TITLE)).toBeVisible();
  await expect(room.getByRole("button", { name: "Go to Ada's lane" })).toHaveAttribute("aria-pressed", "true");
  await expect(lane(page, "Ada").getByRole("region", { name: "Ada asks you" })).toBeVisible();

  // The lane the link lit lets go like any other: picking another lane, then none, leaves Ada's dark.
  const adaPick = room.getByRole("button", { name: "Go to Ada's lane" });
  await laneHead(page, "Ada").click();
  await expect(adaPick).toHaveAttribute("aria-pressed", "false");
  expect(new URL(page.url()).hash).not.toContain("lane=");
  await laneHead(page, "Quill").click();
  await expect(room.getByRole("button", { name: "Go to Quill's lane" })).toHaveAttribute("aria-pressed", "true");
  await laneHead(page, "Quill").click();
  await expect(room.getByRole("button", { name: "Go to Quill's lane" })).toHaveAttribute("aria-pressed", "false");
  await expect(adaPick).toHaveAttribute("aria-pressed", "false");
  expect(new URL(page.url()).hash).not.toContain("lane=");
});

// covers UX-002, UX-006
test("[TC-UX-202] the chat column folds to a rail that marks a new message from the lead, which stays unread until the chat opens, and the device keeps the fold", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  const composer = await startQuest(page, url, aldric);
  await openRoom(page, TITLE);

  // Folded from the keyboard, focus lands on the rail's way back; opened again, on the fold button.
  await chat(page).getByRole("button", { name: "Fold the chat" }).focus();
  await page.keyboard.press("Enter");
  const rail = page.getByRole("complementary", { name: "Chat, folded" });
  await expect(rail).toBeVisible();
  await expect(chat(page)).toBeHidden();
  const reopen = rail.getByRole("button", { name: /^Open the chat/ });
  await expect(reopen).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chat(page).getByRole("button", { name: "Fold the chat" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reopen).toBeFocused();

  // Aldric writes again while the chat is folded: the rail marks it.
  await expect(rail.getByRole("button", { name: "Open the chat, new from Aldric" })).toBeVisible({ timeout: 30_000 });
  await expect(rail).toContainText("New from Aldric");
  // Folded away, the chat reads nothing: the hub keeps the thread unread, so Aldric's tile says so.
  const tile = page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /^Aldric, / });
  await expect(tile).toHaveAccessibleName(/, new messages$/);

  // The fold is kept on this device across a reload, and opening the chat clears the mark.
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Chat, folded" })).toBeVisible();
  await expect(tile).toHaveAccessibleName(/, new messages$/);
  await rail.getByRole("button", { name: "Open the chat", exact: true }).click();
  await expect(rail).toBeHidden();
  await expect(composer).toBeVisible();
  await expect(tile).not.toHaveAccessibleName(/, new messages$/);
  await page.reload();
  await expect(chat(page)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Chat, folded" })).toBeHidden();
});

// covers UX-002, UX-006
for (const [width, column] of [
  [1280, 360],
  [1024, 300],
] as const) {
  test(`[TC-UX-${width === 1280 ? 203 : 204}] at ${width} px the room keeps a ${column} px chat column beside the lanes`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { url, aldric } = await questHub();
    await startQuest(page, url, aldric);
    const room = await openRoom(page, TITLE);
    const box = await chat(page).boundingBox();
    // The column's edge is a hairline of its width.
    expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(column - 1);
    expect(Math.round(box?.width ?? 0)).toBeLessThanOrEqual(column);
    // The room and the chat sit side by side, never over each other.
    const roomBox = await room.boundingBox();
    expect((roomBox?.x ?? 0) + (roomBox?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + 1);
    await expect(lane(page, "Ada")).toBeVisible();
  });
}

// covers UX-002, UX-006
test("[TC-UX-205] at 960 px the chat starts folded and opens over the lanes, and the keyboard never drops to the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 800 });
  const { url, aldric } = await questHub();
  await startQuest(page, url, aldric);
  const room = await openRoom(page, TITLE);
  const rail = page.getByRole("complementary", { name: "Chat, folded" });
  await expect(rail).toBeVisible();
  await expect(chat(page)).toBeHidden();

  // Opened, the chat sits over the lanes; folding it again puts the rail back.
  await rail.getByRole("button", { name: "Open the chat", exact: true }).click();
  await expect(chat(page)).toBeVisible();
  const box = await chat(page).boundingBox();
  const roomBox = await room.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeGreaterThan((roomBox?.x ?? 0) + (roomBox?.width ?? 0) - 400);
  await expect(chat(page).getByRole("button", { name: "Fold the chat" })).toBeFocused();
  await chat(page).getByRole("button", { name: "Fold the chat" }).click();
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("button", { name: "Open the chat", exact: true })).toBeFocused();

  // Tabbing through the whole room, from its title to the chat's rail after it, keeps focus on a
  // control at every step and never on the page itself. The walk starts once the Quest waits on
  // Ada's question, so the room holds still while it runs, and ends on the rail, the last control
  // on the page: one more Tab would leave the page whatever the room holds.
  const asks = lane(page, "Ada").getByRole("region", { name: "Ada asks you" });
  await expect(asks).toBeVisible({ timeout: 20_000 });
  const last = rail.getByRole("button", { name: "Open the chat", exact: true });
  await room.getByRole("heading", { name: TITLE }).focus();
  for (let step = 1; !(await last.evaluate((button) => button === document.activeElement)); step++) {
    expect(step, "Tab reaches the chat's rail").toBeLessThanOrEqual(60);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  }

  await room.getByRole("button", { name: "Close room" }).focus();
  await page.keyboard.press("Enter");
  await expect(room).toBeHidden();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

/** Opens the Black Friday room at 960 px once Ada asks, and gives back her question and her Task. */
const roomOnAdasQuestion = async (page: Page) => {
  await page.setViewportSize({ width: 960, height: 800 });
  const { url, aldric } = await questHub();
  await startQuest(page, url, aldric);
  await openRoom(page, TITLE);
  const asks = lane(page, "Ada").getByRole("region", { name: "Ada asks you" });
  await expect(asks).toBeVisible({ timeout: 20_000 });
  const build = laneTask(page, "Build the campaign");
  return { asks, build, backpack: build.getByRole("region", { name: "Backpack for Build the campaign" }) };
};

// covers UX-006
test("[TC-UX-215] a backpack row that has focus when its item is handled hands focus to its card's details", async ({
  page,
}) => {
  const { asks, build, backpack } = await roomOnAdasQuestion(page);
  // The answer is sent without moving focus off the row; the row moves into the card's details.
  await backpack.getByRole("button").focus();
  await asks.getByRole("button", { name: /^Dec 12 for international/ }).dispatchEvent("click");
  await expect(build.getByText("Everything in this task")).toBeFocused();
  await expect(backpack).toHaveCount(0);
});

// covers UX-006
test("[TC-UX-216] answering in a lane by a choice's key moves focus to the lane's header, not to a card the focus left", async ({
  page,
}) => {
  const { asks, build, backpack } = await roomOnAdasQuestion(page);
  // Focus visits the row, then moves to Ada's choice, which answers. The row and the choice both go,
  // and the card does not take focus back: it had already left the card. With nothing else waiting
  // in Ada's lane, focus moves to its header (#995), and a toast says what was sent.
  await backpack.getByRole("button").focus();
  const choice = asks.getByRole("button", { name: /^Dec 12 for international/ });
  await choice.focus();
  await page.keyboard.press("1");
  await expect(backpack).toHaveCount(0);
  await expect(laneHead(page, "Ada")).toBeFocused();
  await expect(build.getByText("Everything in this task")).not.toBeFocused();
  await expect(
    page.getByRole("region", { name: /^Notifications/ }).getByText("Sent your answer to Ada: Dec 12 for international"),
  ).toBeVisible();
});

// covers UX-006
test("[TC-UX-217] answering in a lane by a choice chip moves focus to the lane's header once nothing else waits there", async ({
  page,
}) => {
  const { asks } = await roomOnAdasQuestion(page);
  // A chip pressed from the keyboard answers like its number key, and focus never drops to the page.
  await asks.getByRole("button", { name: /^Dec 12 for international/ }).focus();
  await page.keyboard.press("Enter");
  await expect(asks).toHaveCount(0);
  await expect(laneHead(page, "Ada")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await expect(
    page.getByRole("region", { name: /^Notifications/ }).getByText("Sent your answer to Ada: Dec 12 for international"),
  ).toBeVisible();
});

// covers UX-002, OR-001
test("[TC-UX-206] the Workbench docks under the lanes, folded until a tab or a lane opens it, and follows the lit lane", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await startQuest(page, url, aldric);
  const room = await openRoom(page, TITLE);
  const bench = dock(page);
  const lit = bench.getByRole("heading", { level: 2 });
  await expect(bench.getByRole("button", { name: "Open the Workbench" })).toHaveAttribute("aria-expanded", "false");
  await expect(bench.getByRole("tab")).toHaveText([/^Changes/, /^Files/, /^Terminal/, "BrowserSoon"]);

  // Opened with no lane lit, it shows everyone's work on Changes.
  await bench.getByRole("button", { name: "Open the Workbench" }).click();
  await expect(bench.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await expect(lit).toHaveCount(0);
  // A lane shows that hob's work alone, named over the tabs.
  await room.getByRole("button", { name: "Show Quill's work in the Workbench" }).click();
  await expect(lit).toHaveText("Draft the landing copy");
  await expect(bench.getByRole("button", { name: /^Quill only/ })).toBeVisible();
  // Clicking the lit lane again shows everyone.
  await room.getByRole("button", { name: "Show Quill's work in the Workbench" }).click();
  await expect(lit).toHaveCount(0);
  await bench.getByRole("button", { name: "Fold the Workbench" }).click();
  await expect(bench.getByRole("tabpanel")).toHaveCount(0);
  expect(new URL(page.url()).hash).not.toContain("tab=");

  // Folded, a lane slides it open on that hob's work.
  await room.getByRole("button", { name: "Show Quill's work in the Workbench" }).click();
  await expect(bench.getByRole("button", { name: "Fold the Workbench" })).toHaveAttribute("aria-expanded", "true");
  await expect(lit).toHaveText("Draft the landing copy");
});

const themeIds: readonly string[] = (
  JSON.parse(readFileSync(new URL("../../../docs/design/themes.json", import.meta.url), "utf8")) as {
    readonly themes: readonly { readonly id: string }[];
  }
).themes.map((theme) => theme.id);

// covers UX-002, UX-006
test("[TC-UX-207] the room, its lanes, the docked Workbench and the folded chat hold up in every theme", async ({
  page,
}) => {
  expect(themeIds).toHaveLength(4);
  const { url, aldric } = await questHub();
  await startQuest(page, url, aldric);
  const room = await openRoom(page, TITLE);
  for (const theme of themeIds) {
    await page.evaluate((id) => localStorage.setItem("hobbots.theme", JSON.stringify(id)), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(room.getByRole("heading", { name: TITLE })).toBeVisible();
    for (const name of ["Aldric", "Quill", "Ada"]) await expect(lane(page, name)).toBeVisible();
    await expect(dock(page).getByRole("button", { name: "Open the Workbench" })).toBeVisible();
    const box = await chat(page).boundingBox();
    expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(359);
    await chat(page).getByRole("button", { name: "Fold the chat" }).click();
    await expect(page.getByRole("complementary", { name: "Chat, folded" })).toBeVisible();
    await page.getByRole("button", { name: "Open the chat", exact: true }).click();
    await expect(chat(page)).toBeVisible();
  }
});
