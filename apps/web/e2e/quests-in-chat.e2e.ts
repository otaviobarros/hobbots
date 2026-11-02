import { expect, test } from "@playwright/test";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers OR-001, OR-004, CH-005, UX-001
test("[TC-OR-013] the Black Friday Quest can be followed end to end from the chat with its lead", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  // The card sits under the request, with the party and the rows that matter.
  const card = page.getByRole("region", { name: "Aldric's work on Plan the Black Friday campaign" });
  await expect(card).toContainText("Aldric is on it");
  await expect(card).toContainText("Aldric's party: Quill and Ada");
  await expect(card.getByRole("button", { name: "Look inside Build the campaign" })).toContainText("waiting on Quill");

  // The strip keeps it in view; a lead's answer shows as one line; a question for you asks.
  const strip = page.getByRole("region", { name: "Work in progress" });
  await expect(strip.getByRole("button", { name: "Show Aldric's work" })).toContainText("Aldric's quest");
  await expect(page.getByText("Aldric answered Quill for you")).toBeVisible();
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff");
  await expect(card.getByRole("button", { name: "Look inside Build the campaign" })).toContainText("Needs you");
  await expect(strip).toContainText("1 needs you");

  // The drawer opens a Task beside the chat, by keyboard too, and Escape closes it.
  await card.getByRole("button", { name: "Look inside Build the campaign" }).click();
  const drawer = page.getByRole("complementary", { name: "Build the campaign, Task details" });
  await expect(drawer.getByRole("heading", { name: "Build the campaign" })).toBeFocused();
  await expect(drawer).toContainText("Aldric gave it");
  await expect(drawer).toContainText("Keyword research done while waiting on Quill");
  await expect(drawer).toContainText("Black Friday: 20% off everything, this weekend only.");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // A note in the drawer goes to Aldric as a message about that Task, and stays with that Task.
  await strip.getByRole("button", { name: "Show Aldric's work" }).click();
  const quest = page.getByRole("complementary", { name: "Plan the Black Friday campaign, Task details" });
  await quest.getByRole("button", { name: /Draft the landing copy/ }).click();
  const note = page.getByRole("textbox", { name: "Tell Aldric about this task" });
  await note.fill("Keep the headlines short.");
  await page.getByRole("button", { name: "Back to Plan the Black Friday campaign" }).click();
  await expect(quest).toBeVisible();
  await expect(note).toHaveValue("");
  await quest.getByRole("button", { name: /Draft the landing copy/ }).click();
  await expect(note).toHaveValue("Keep the headlines short.");
  await note.press("Enter");
  const copyTask = page.getByRole("complementary", { name: "Draft the landing copy, Task details" });
  await expect(copyTask).toContainText("Sent to Aldric.");
  await expect(copyTask).toContainText("Your notes");
  await expect(copyTask).toContainText("Keep the headlines short.");
  await expect(copyTask).toContainText("To Aldric");
  await expect(note).toHaveValue("");
  await page.getByRole("button", { name: "Close" }).click();

  // Your answer goes back; the Quest finishes and Aldric wraps up in the chat.
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(asks).toContainText("You answered: Yes, Dec 12 for international orders.");
  await expect(card).toContainText("Aldric finished this", { timeout: 15_000 });
  await expect(strip).toBeHidden();
  await expect(page.getByText("The Black Friday campaign is ready.")).toBeVisible();

  // Once it ends, the card still opens the Task with its output.
  await card.getByRole("button", { name: "Show all" }).click();
  await expect(quest).toContainText("Black Friday campaign ready");
});

// covers OR-004, IN-002
test("[TC-IN-132] a question no lead could answer waits in the Inbox's Needs you, and your answer there reaches the chat", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const asksInChat = page.getByRole("region", { name: "Ada asks you" });
  await expect(asksInChat).toBeVisible();
  const chat = page.url();

  await page.goto(`${url}/#/inbox?tab=needs`);
  const questions = page.getByRole("region", { name: "Questions for you" });
  await expect(questions).toContainText("1 question for you");
  const asks = questions.getByRole("region", { name: "Question from Ada" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff");
  await expect(asks).toContainText("For Build the campaign");
  await expect(asks).toContainText("Passed up to you by Aldric.");
  await expect(page.getByText("1 waiting on you")).toBeVisible();

  const answer = asks.getByRole("textbox", { name: "Your answer to Ada" });
  await answer.fill("Yes, Dec 12 for international orders.");
  await expect(asks.getByRole("button", { name: "Send answer" })).toBeEnabled();
  await answer.press("Enter");
  await expect(questions).toBeHidden();
  await expect(page.getByText("Nothing needs you")).toBeVisible();

  // The chat shows the answer you gave from the Inbox.
  await page.goto(chat);
  await expect(asksInChat).toContainText("You answered: Yes, Dec 12 for international orders.");
});
