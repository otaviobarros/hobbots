import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { cancelInLane, laneHead, laneTask, openRoom, questRoom, taskDetails, ticket } from "./quest-room.ts";

test.afterEach(stopQuestHub);

// covers OR-001, OR-004, CH-005, UX-001, UX-002
test("[TC-OR-013] the Black Friday Quest can be followed end to end from the chat with its lead", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  // The ticket sits under the request, counting the party's Tasks.
  const questTicket = ticket(page, "Plan the Black Friday campaign");
  await expect(questTicket).toContainText("of 2 done");

  // The quest button in the header keeps it in view; a lead's answer shows as one line; a question for you asks.
  const strip = page.getByRole("region", { name: "Work in progress" });
  await expect(strip.getByRole("button", { name: /^Plan the Black Friday campaign/ })).toContainText("of 2 done");
  await expect(page.getByText("Aldric answered Quill for you")).toBeVisible();
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff");
  await expect(questTicket).toContainText("1 needs you");
  await expect(strip).toContainText("1 needs you");

  // The ticket opens the room beside the chat, by keyboard too, and Close room closes it.
  await questTicket.focus();
  await page.keyboard.press("Enter");
  const room = questRoom(page, "Plan the Black Friday campaign");
  await expect(room.getByRole("heading", { name: "Plan the Black Friday campaign" })).toBeFocused();
  await expect(laneHead(page, "Ada")).toContainText("Needs you");
  const drawer = await taskDetails(page, "Build the campaign");
  await expect(drawer).toContainText("Aldric gave it");
  await expect(drawer).toContainText("Keyword research done");
  await expect(drawer).toContainText("Doorbuster and early access lead what shoppers search for.");
  await expect(drawer).toContainText("Black Friday: 20% off everything, this weekend only.");
  await room.getByRole("button", { name: "Close room" }).click();
  await expect(room).toBeHidden();

  // Your answer goes back; the Quest finishes and Aldric wraps up in the chat.
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(asks).toContainText("You answered here: Yes, Dec 12 for international orders.");
  // Aldric finishes only once his chat has read each member's result, a paced fake reply apiece.
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await expect(strip).toBeHidden();
  await expect(page.getByText("The Black Friday campaign is ready.")).toBeVisible();
  // The lead's chat holds only the plan, the question no lead could answer and the finish (#901):
  // its turns on each member's result wrote nothing, and leave no row.
  const replies = page.getByRole("article");
  await expect(replies).toHaveCount(3);
  await expect(replies.nth(0)).toContainText("Plan a Black Friday campaign for the shop");
  await expect(replies.nth(1)).toContainText("Ada has one question for you about the international cutoff.");
  await expect(replies.nth(2)).toContainText("Quill wrote the copy and Ada scheduled the email");

  // Once it ends, the ticket still opens the room, and the lead's own Task shows its output.
  await openRoom(page, "Plan the Black Friday campaign");
  await expect(laneTask(page, "Plan the Black Friday campaign", "Aldric")).toContainText("Black Friday campaign ready");
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
  // It is one row in the list, like every other kind, and opens beside it with its answer box.
  const questions = page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Question/ });
  await expect(questions).toContainText("Ada → Aldric → you");
  const asks = page.getByRole("article", { name: "Question from Ada" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff");
  await expect(asks).toContainText("Build the campaign");
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
  await expect(asksInChat).toContainText("You answered in the Inbox: Yes, Dec 12 for international orders.");
});

// covers OR-004, OR-006, IN-002
test("[TC-IN-154] cancelling the work a question waits on withdraws it from the Inbox, the chat and the Quest room, and the lead still finishes", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const asks = page.getByRole("region", { name: "Ada asks you" });
  const answer = asks.getByRole("textbox", { name: "Your answer to Ada" });
  await expect(answer).toBeVisible({ timeout: 15_000 });
  const chat = page.url();

  // You cancel Ada's Task from her lane before answering her.
  await openRoom(page, "Plan the Black Friday campaign");
  const drawer = await taskDetails(page, "Build the campaign");
  const ada = await cancelInLane(page, "Ada");
  await expect(ada.getByRole("status").filter({ hasText: "Cancelled: the task confirmed it stopped." })).toBeVisible({
    timeout: 15_000,
  });

  // Nobody is left to hear the answer: the question says so instead of asking, and so does the drawer.
  const withdrawn = "Withdrawn: the work it was about ended before anyone answered.";
  const inChat = page.getByRole("main", { name: "Chat" }).getByRole("region", { name: "Ada asks you" });
  await expect(inChat).toContainText(withdrawn);
  await expect(answer).toHaveCount(0);
  await expect(drawer).toContainText("Withdrawn when this task ended.");

  // The question no longer holds Aldric's work open: he wraps up without Ada's part.
  await expect(page.getByText("The Black Friday campaign is wrapped up without Ada's part")).toBeVisible({
    timeout: 30_000,
  });

  // It no longer waits for you in the Inbox, and the chat still shows it withdrawn after a reload.
  await page.goto(`${url}/#/inbox?tab=needs`);
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Question/ })).toHaveCount(0);
  await page.goto(chat);
  await page.reload();
  await expect(asks).toContainText(withdrawn);
  await expect(answer).toHaveCount(0);
});
