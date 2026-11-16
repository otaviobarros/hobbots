import type { Message } from "@hobbots/domain";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #1484 (ADR 039, Reply threads): any message can have a reply thread, as in Slack. It opens
// beside the chat from the message's menu, the replies stay out of the main line unless also sent
// there, the root shows the thread in one line, and the address keeps it open. No hob answers in a
// thread yet (#1485).

test.afterEach(stopAldricHub);

const channelOf = (page: Page) => new URL(page.url()).hash.split("/channels/")[1]?.split("?")[0] ?? "";

// covers ADR 039 (Reply threads)
test("replies in a thread beside the chat, keeps the replies out of the main line unless also sent there (#1484)", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Who's picking up the tables from storage on Friday?");
  await composer.press("Enter");
  await expect(main.getByText("Echo: Who's picking up the tables from storage on Friday?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  // Reply in thread, from the message's menu, opens the thread beside the chat.
  const asked = main.getByText("Who's picking up the tables from storage on Friday?", { exact: true });
  await asked.locator("..").getByRole("button", { name: "More for this message" }).click();
  await page.getByRole("menuitem", { name: "Reply in thread" }).click();
  const thread = main.getByRole("complementary", { name: "Thread" });
  await expect(thread).toContainText("No replies yet");
  await expect(page).toHaveURL(/thread=/);
  await expect(thread.getByText("No hob will answer")).toBeVisible();
  await expectAccessible(page, thread);

  // A reply stays in the thread; the root shows it in one line.
  const box = thread.getByRole("textbox", { name: "Reply in thread" });
  await box.fill("I can, after 2.");
  await box.press("Enter");
  await expect(thread.getByText("I can, after 2.", { exact: true })).toBeVisible();
  await expect(thread).toContainText("1 reply");
  await expect(main.getByRole("button", { name: /^1 reply/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Messages" }).getByText("I can, after 2.")).toHaveCount(0);

  // Also send to the chat puts the reply in the main line too, with a way back to its thread.
  await box.fill("Two cars should do it.");
  await thread.getByRole("checkbox", { name: "Also send to the chat" }).check();
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thread).toContainText("Also sent to the chat");
  await expect(thread.getByRole("checkbox", { name: "Also send to the chat" })).not.toBeChecked();
  const transcript = page.getByRole("region", { name: "Messages" });
  await expect(transcript.getByText("Two cars should do it.", { exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: /^2 replies/ })).toBeVisible();

  // No hob answered either reply.
  const stored = (await (
    await fetch(`${url}/api/channels/${channelOf(page)}/messages`, { headers: hub.headers })
  ).json()) as ReadonlyArray<Message>;
  expect(stored.map((message) => [message.content, message.rootMessageId !== null, message.alsoInMainLine])).toEqual([
    ["Who's picking up the tables from storage on Friday?", false, false],
    ["Echo: Who's picking up the tables from storage on Friday?", false, false],
    ["I can, after 2.", true, false],
    ["Two cars should do it.", true, true],
  ]);

  // Closing gives the chat its width back; the line opens the thread again, and a reload keeps it.
  await thread.getByRole("button", { name: "Close the thread" }).click();
  await expect(thread).toBeHidden();
  await transcript.getByRole("button", { name: "From a thread" }).click();
  await expect(thread).toContainText("2 replies");
  await page.reload();
  await expect(main.getByRole("complementary", { name: "Thread" })).toContainText("I can, after 2.");
});
