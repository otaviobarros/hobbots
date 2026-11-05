import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, laneTask, openRoom, questRoom, ticket } from "./quest-room.ts";

test.afterEach(stopQuestHub);

const QUESTION = "Should international orders get an earlier cutoff";

/** Starts the Black Friday Quest, waits for Ada's question to reach you, and opens the room on her lane. */
const openAdasTask = async (page: Page) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 15_000 });
  await openRoom(page, "Plan the Black Friday campaign");
  const drawer = laneTask(page, "Build the campaign");
  await expect(drawer).toContainText(QUESTION);
  return { url, drawer };
};

// covers OR-004, IN-002, UX-001
test("[TC-UX-085] a question waiting for you is answered in its lane in the Quest room, goes back to the hob that asked, and leaves the Inbox", async ({
  page,
}) => {
  const { url, drawer } = await openAdasTask(page);

  // Ada's lane offers the same answer box as the chat, right under the question, saying how the answer travels.
  const asks = lane(page, "Ada").getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Goes to Aldric, who passes it to Ada.");
  const answer = asks.getByRole("textbox", { name: "Your answer to Ada" });
  await answer.fill("Yes, Dec 12 for international orders.");
  await expect(asks.getByRole("button", { name: "Send answer" })).toBeEnabled();
  await answer.press("Enter");

  // The question closes in place, and the chat shows the same answer, each saying where you gave it (#671).
  await expect(drawer).toContainText("You answered here: Yes, Dec 12 for international orders.");
  await expect(answer).toHaveCount(0);
  await questRoom(page, "Plan the Black Friday campaign").getByRole("button", { name: "Close room" }).click();
  await expect(page.getByRole("region", { name: "Ada asks you" })).toContainText(
    "You answered in the Quest room: Yes, Dec 12 for international orders.",
  );

  // Once the question is answered, her part finishes and the Quest wraps up.
  const questTicket = ticket(page, "Plan the Black Friday campaign");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });

  // Nothing waits for you in the Inbox any more.
  await page.goto(`${url}/#/inbox?tab=needs`);
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Question/ })).toHaveCount(0);
});

// covers OR-004, IN-002, UX-001
test("[TC-IN-489] an answer given in the Inbox says so in the Quest room and on the chat's card", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 15_000 });
  const thread = page.url();

  await page.goto(`${url}/#/inbox?tab=needs`);
  const asked = page.getByRole("article", { name: "Question from Ada" });
  await asked.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12.");
  await asked.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Question/ })).toHaveCount(0);

  await page.goto(thread);
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("You answered in the Inbox: Yes, Dec 12.");
  // The Quest may have wrapped up by now, so the room opens from the question's own card.
  await asks.getByRole("button", { name: "for Build the campaign" }).click();
  const drawer = laneTask(page, "Build the campaign");
  await expect(drawer).toContainText("You answered in the Inbox: Yes, Dec 12.");
});

// covers UX-006
test("[TC-UX-218] answering in the chat's Needs-you tray moves focus to the composer once nothing else waits, and says what was sent", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const tray = page.getByRole("region", { name: /^Needs you/ });
  const asks = tray.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toBeVisible({ timeout: 15_000 });

  // The choice's key answers; the item leaves the tray with the control that had focus, and focus
  // goes to the composer rather than the page (#995).
  await asks.getByRole("button", { name: /^Dec 12 for international/ }).focus();
  await page.keyboard.press("1");
  await expect(asks).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(
    page.getByRole("region", { name: /^Notifications/ }).getByText("Sent your answer to Ada: Dec 12 for international"),
  ).toBeVisible();
});
