import { expectAccessible } from "./accessibility.ts";
import { campAt, expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { dock, lane, questSheet } from "./quest-sheet.ts";

test.afterEach(stopQuestHub);

// Issue #1390 (ADR 037): a camp's quests open in its sheet, with a link back to the camp, and the
// lanes layout is gone. Asking Aldric for gift cards in a camp has Quill and Ada both claim the
// checkout's payments file and stay at work, so the camp shows the hub's Heads-up on the clash.
// The hub's side is apps/server/test/claims.test.ts.

const TITLE = "Take gift cards at checkout";

/** Aldric's camp, with the gift cards quest asked for and both members at work. */
const giftCards = async (page: import("@playwright/test").Page) => {
  const { url, headers, aldric } = await questHub();
  const camp = await campAt({ url, headers }, aldric, "Checkout");
  await page.goto(camp.url);
  const composer = page.getByRole("textbox", { name: /^Message Aldric in/ });
  await composer.fill("Take gift cards at checkout, please");
  await composer.press("Enter");
  return { url, headers, aldric, camp };
};

// covers ADR 037 (quests in the camp)
test("[TC-UX-1390-12] opens a quest from the camp's pill, steers it from the sheet and sees the receipt", async ({
  page,
}) => {
  await giftCards(page);
  const main = page.getByRole("main", { name: "Chat" });

  // The pill in the header counts the camp's quests and opens its sheet, which lists them.
  const pill = main.getByRole("button", { name: /^1 quest.*Open the camp's quests$/ });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await pill.click();
  const campSheet = page.getByRole("dialog", { name: "Checkout" });
  await campSheet.getByRole("button", { name: /Shoppers can pay with a gift card at checkout/ }).click();

  // The quest opens in the same sheet, with each hob's work, and a link back to the camp.
  const quest = questSheet(page, TITLE);
  await expect(quest).toBeVisible();
  await expect(lane(page, "Quill")).toContainText("Take gift cards", { timeout: 15_000 });
  await expect(lane(page, "Ada")).toContainText("Fix the rounding", { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Lanes" })).toHaveCount(0);
  await expectAccessible(page, quest);

  // A message from the quest's composer steers Aldric, and its receipt says he got it.
  const composer = quest.getByRole("textbox", { name: "Message Aldric about this quest" });
  await composer.fill("Keep the rounding change small");
  await composer.press("Enter");
  const thread = quest.getByRole("region", { name: "Thread" });
  await expect(thread).toContainText("Keep the rounding change small");
  await expect(thread.getByRole("region", { name: "Where your message went" })).toContainText("Aldric got it", {
    timeout: 30_000,
  });

  // The Workbench opens beside the chat from the quest, and goes back to it with what you were
  // typing still in the box, as it is after the sheet closes and opens again.
  await composer.fill("Ship it behind a flag");
  await quest.getByRole("button", { name: "Show the work" }).click();
  await expect(dock(page)).toBeVisible();
  await page.getByRole("button", { name: "Back to the quest" }).click();
  await expect(questSheet(page, TITLE)).toBeVisible();
  await expect(composer).toHaveValue("Ship it behind a flag");

  // Back leads to the camp's sheet; closing it closes both.
  await questSheet(page, TITLE).getByRole("button", { name: "Back to Checkout" }).click();
  await expect(page.getByRole("dialog", { name: "Checkout" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// covers ADR 037 (Heads-up)
test("[TC-UX-1390-13] a path clash between two tasks shows a Heads-up in the camp", async ({ page }) => {
  await giftCards(page);
  const main = page.getByRole("main", { name: "Chat" });
  const headsUp = main.getByRole("region", { name: "Heads-up: 2 tasks change the same files" });
  await expect(headsUp).toBeVisible({ timeout: 15_000 });
  await expect(headsUp).toContainText("Quill, Take gift cards: checkout/payments.ts");
  await expect(headsUp).toContainText("Ada, Fix the rounding: checkout/payments.ts");
  await expect(headsUp).toContainText("Spotted by the hub when Ada claimed checkout/payments.ts");
  await expectAccessible(page, headsUp);

  // Cancelling Quill's work releases his claim, and the Heads-up goes.
  await main.getByRole("button", { name: /^1 quest/ }).click();
  await page
    .getByRole("dialog", { name: "Checkout" })
    .getByRole("button", { name: /Shoppers can pay with a gift card at checkout/ })
    .click();
  const menu = lane(page, "Quill").getByRole("button", { name: "Quill's task menu" });
  await menu.click();
  await page.getByRole("menu", { name: "Quill's task" }).getByRole("menuitem", { name: "Cancel task…" }).click();
  await lane(page, "Quill").getByRole("button", { name: "Yes, cancel" }).click();
  await page.keyboard.press("Escape");
  await expect(headsUp).toHaveCount(0, { timeout: 15_000 });
});

// covers ADR 037 (quests in the camp), STD-REACT-015
test("[TC-UX-1390-15] a pinned quest whose chat could not be read says so, never that nothing was said, and Try again reads it", async ({
  page,
}) => {
  const { url, headers, aldric, camp } = await giftCards(page);
  await expect(page.getByRole("main", { name: "Chat" }).getByRole("button", { name: /^1 quest/ })).toBeVisible({
    timeout: 15_000,
  });
  const read = await fetch(`${url}/api/threads/${camp.id}/tasks`, { headers });
  const { trees } = (await read.json()) as {
    readonly trees: ReadonlyArray<{ readonly tasks: ReadonlyArray<{ readonly id: string }> }>;
  };
  const quest = trees[0]?.tasks[0]?.id;
  if (quest === undefined) throw new Error("expected the gift cards quest");

  // Pinned, the quest opens from another camp, where its own chat's messages cannot be read yet.
  let failing = true;
  await page.route(new RegExp(`/api/threads/${camp.id}/messages$`), async (route) => {
    if (failing && route.request().method() === "GET") await route.fulfill({ status: 500, body: "" });
    else await route.continue();
  });
  await page.evaluate((id) => localStorage.setItem("quest.pinned", JSON.stringify([id])), quest);
  const other = await campAt({ url, headers }, aldric, "Payments");
  await page.goto(other.url);
  await page.reload();
  await page
    .getByRole("region", { name: "Work in progress" })
    .getByRole("button", { name: new RegExp(TITLE) })
    .click();

  const thread = questSheet(page, TITLE).getByRole("region", { name: "Thread" });
  const unread = thread.getByRole("alert");
  await expect(unread).toContainText("What was said in this quest could not be read.", { timeout: 20_000 });
  await expect(thread).not.toContainText("Nothing said yet");

  failing = false;
  await unread.getByRole("button", { name: "Try again" }).click();
  await expect(thread).toContainText("Take gift cards at checkout, please");
  await expect(unread).toHaveCount(0);
});
