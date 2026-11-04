import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

const QUESTION = "Should international orders get an earlier cutoff";

/** Starts the Black Friday Quest, waits for Ada's question to reach you, and opens her Task's drawer. */
const openAdasTask = async (page: Page) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 15_000 });
  const card = page.getByRole("region", { name: "Aldric's work on Plan the Black Friday campaign" });
  await card.getByRole("button", { name: "Look inside Build the campaign" }).click();
  const drawer = page.getByRole("complementary", { name: "Build the campaign, Task details" });
  await expect(drawer).toContainText(QUESTION);
  return { url, drawer };
};

// covers OR-004, IN-002, UX-001
test("[TC-UX-085] a question waiting for you is answered in the Task drawer, goes back to the hob that asked, and leaves the Inbox", async ({
  page,
}) => {
  const { url, drawer } = await openAdasTask(page);

  // The drawer offers the same answer box as the chat, right under the question.
  await expect(drawer).toContainText("Ada asks you. Your answer goes straight back to Ada.");
  const answer = drawer.getByRole("textbox", { name: "Your answer to Ada" });
  await answer.fill("Yes, Dec 12 for international orders.");
  await expect(drawer.getByRole("button", { name: "Send answer" })).toBeEnabled();
  await answer.press("Enter");

  // The question closes in place, and the chat's card shows the same answer, each saying where you gave it (#671).
  await expect(drawer).toContainText("You answered here: Yes, Dec 12 for international orders.");
  await expect(answer).toHaveCount(0);
  await expect(drawer.getByRole("textbox", { name: "Tell Aldric about this task" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("region", { name: "Ada asks you" })).toContainText(
    "You answered in the Task's details: Yes, Dec 12 for international orders.",
  );

  // Once the question is answered, her part finishes and the Quest wraps up.
  const card = page.getByRole("region", { name: "Aldric's work on Plan the Black Friday campaign" });
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });

  // Nothing waits for you in the Inbox any more.
  await page.goto(`${url}/#/inbox?tab=needs`);
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Question/ })).toHaveCount(0);
});

// covers OR-004, IN-002, UX-001
test("[TC-UX-086] while a question waits for you, the drawer's note box says it is a note to the lead, and a note leaves the question open", async ({
  page,
}) => {
  const { url, drawer } = await openAdasTask(page);

  // The box is named for what it does: a note to Aldric, not an answer to Ada.
  const note = drawer.getByRole("textbox", { name: "Note to Aldric, not an answer" });
  await expect(note).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Tell Aldric about this task" })).toHaveCount(0);
  await expect(drawer).toContainText("This goes to Aldric as a note. To answer Ada, use the answer box above.");

  // A note goes to Aldric as a note, and Ada's question still waits for you.
  await note.fill("dark");
  await note.press("Enter");
  await expect(drawer).toContainText("Sent to Aldric.");
  await expect(drawer).toContainText("Your notes");
  await expect(drawer).toContainText("To Aldric");
  await expect(drawer.getByRole("textbox", { name: "Your answer to Ada" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ada asks you" }).getByRole("textbox")).toBeVisible();

  await page.goto(`${url}/#/inbox?tab=needs`);
  const row = page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Question/ });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Question from Ada" })).toContainText(QUESTION);
});

// covers OR-004, IN-002, UX-001
test("[TC-IN-489] an answer given in the Inbox says so in the Task drawer and on the chat's card", async ({ page }) => {
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
  // The Quest may have wrapped up by now, so the drawer opens from the question's own card.
  await asks.getByRole("button", { name: "for Build the campaign" }).click();
  const drawer = page.getByRole("complementary", { name: "Build the campaign, Task details" });
  await expect(drawer).toContainText("You answered in the Inbox: Yes, Dec 12.");
});
