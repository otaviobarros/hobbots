import type { Message, Thread } from "@hobbots/domain";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { campAt, expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1387 (ADR 037): a camp's sheet, the camp suggestion card, notes to self, pins and catch-up
// in the browser, on the fake runtime. The sheet lists the brief, decisions, artifacts and what is
// yours; a suggestion moves a chat's chapter into a new camp; a note wakes no hob; and coming back to
// a chat you left unread says what changed while you were away.

test.afterEach(stopAldricHub);

const threadOf = (page: Page) => new URL(page.url()).hash.split("/threads/")[1]?.split("?")[0] ?? "";

/** Sends `lines` as one message and waits until the reply, which echoes them, has ended. */
const say = async (page: Page, composerName: RegExp, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: composerName });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  const main = page.getByRole("main", { name: "Chat" });
  await expect(main.getByRole("article").filter({ hasText: lines[0]?.slice(0, 30) ?? "" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
};

// covers CH-001, ADR 037 (Records, Mine)
test("[TC-CH-1387-10] records and changes a decision, opens an artifact, writes a note, pins a reply and makes the camp private", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  const camp = await campAt(hub, aldric, "Launch");
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(camp.url);
  await say(page, /^Message Aldric in/, [
    "Plan the launch.",
    'fake:write plan.md "# Plan\\n"',
    script("record_decision", { key: "fridays", text: "Ship on Fridays." }),
  ]);

  // The sheet opens from the header, on its Overview.
  await main.getByRole("button", { name: "Open the sheet for Launch" }).click();
  const sheet = page.getByRole("dialog", { name: "Launch" });
  await expect(sheet).toContainText("Aldric's camp");
  await expect(sheet.getByRole("region", { name: "Where we are" })).toBeVisible();
  await expectAccessible(page, sheet);

  // Decisions: Aldric's, changed to yours, which crosses his out and keeps it.
  await sheet.getByRole("tab", { name: /^Decisions/ }).click();
  await expect(sheet.getByText("Ship on Fridays.")).toBeVisible();
  await sheet.getByRole("button", { name: "Change “Ship on Fridays.”" }).click();
  await sheet.getByRole("textbox", { name: "Decision" }).fill("Ship on Wednesdays.");
  await sheet.getByRole("button", { name: "Save the decision" }).click();
  await expect(sheet.getByText("Changed to Ship on Wednesdays.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Cross out “Ship on Fridays.”" })).toBeHidden();
  await expect(sheet.getByRole("tab", { name: /^Decisions/ })).toContainText("2");
  await expectAccessible(page, sheet);

  // Artifacts: the file Aldric wrote, opened, and back to where he made it.
  await sheet.getByRole("tab", { name: /^Artifacts/ }).click();
  await sheet.getByRole("button", { name: "Open plan.md" }).click();
  await expect(sheet.getByRole("region", { name: "plan.md" })).toContainText("plan.md");
  await expect(sheet).toContainText("Made by");
  await sheet.getByRole("button", { name: "Show where it was made" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\?message=/);

  // A note to self wakes no hob.
  await page.getByRole("button", { name: "Note to self" }).click();
  await expect(page.getByRole("button", { name: "Note to self" })).toHaveAttribute("aria-pressed", "true");
  const noteBox = page.getByRole("textbox", { name: /^Message Aldric in/ });
  await noteBox.fill("Ask Ana about the venue.");
  await noteBox.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved under Mine · no hob woke" })).toBeVisible();
  await expect(main.getByText("Ask Ana about the venue.", { exact: true })).toBeVisible();
  await expect(main).toContainText("Note to self · only you");
  await expect(main.getByText("Echo: Ask Ana about the venue.")).toHaveCount(0);

  // Pin Aldric's reply from its menu.
  const reply = main.getByRole("article").filter({ hasText: "Echo: Plan the launch." });
  await reply.getByRole("button", { name: "More for this message" }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(reply.getByRole("img", { name: "Pinned" })).toBeVisible();

  // Mine lists the pin and the note; Overview makes the camp private from now on.
  await main.getByRole("button", { name: "Open the sheet for Launch" }).click();
  await sheet.getByRole("tab", { name: /^Mine/ }).click();
  await expect(sheet.getByRole("region", { name: "Pinned" })).toContainText("Echo: Plan the launch.");
  await expect(sheet.getByRole("region", { name: "Notes to self" })).toContainText("Ask Ana about the venue.");
  await sheet.getByRole("tab", { name: "Overview" }).click();
  await sheet.getByRole("switch", { name: "Private camp" }).click();
  await expect(sheet).toContainText("What was captured before stays.");
  await expect
    .poll(async () => {
      const listed = (await (
        await fetch(`${url}/api/agents/${aldric}/threads`, { headers: hub.headers })
      ).json()) as ReadonlyArray<Thread>;
      return listed.find((thread) => thread.id === camp.id)?.private;
    })
    .toBe(true);
});

// covers CH-001, ADR 037 (CampSuggestion, Moving a chapter into a camp moves it)
test("[TC-CH-1387-11] offers a grown chat chapter as a camp and moves it into the new camp", async ({ page }) => {
  const { url, aldric, api, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, /^Message Aldric/, ["Let us plan the launch."]);
  const chat = threadOf(page);
  for (let n = 1; n <= 5; n++) {
    await api("POST", `/threads/${chat}/decisions`, { key: `d${n}`, text: `Decision ${n}`, replaces: null });
  }

  const card = main.getByRole("region", { name: "Make Chapter 1 a camp?" });
  await expect(card).toContainText("Aldric suggests");
  await expect(card).toContainText("5 decisions");
  await expectAccessible(page, card);
  await card.getByRole("button", { name: "Make it a camp" }).click();
  const sheet = page.getByRole("dialog", { name: "Make a camp" });
  await expect(sheet.getByRole("switch", { name: "The Chapter 1 chapter" })).toBeChecked();
  await sheet.getByRole("textbox", { name: "Name" }).fill("Launch");
  await sheet.getByRole("button", { name: "Make the camp" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(chat));
  await expect(main.locator("header").first()).toContainText("Launch");
  // The chapter's messages came along, and the chat no longer holds them.
  await expect(main.getByText("Echo: Let us plan the launch.")).toBeVisible();
  const left = (await (
    await fetch(`${url}/api/threads/${chat}/messages`, { headers: hub.headers })
  ).json()) as ReadonlyArray<Message>;
  expect(left).toEqual([]);
});

// covers CH-001, ADR 037 (Catch-up)
test("[TC-CH-1387-12] catches you up on a chat you left, then folds it", async ({ page }) => {
  const { url, aldric, api, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, /^Message Aldric/, ["Hello."]);
  const chat = threadOf(page);
  const address = page.url();

  // You leave; Aldric replies and records a decision meanwhile.
  await page.goto(`${url}/#/hobs/${aldric}`);
  await api("POST", `/threads/${chat}/messages`, {
    content: ["While you are out.", script("record_decision", { key: "fridays", text: "Ship on Fridays." })].join("\n"),
  });
  const unread = async () => {
    const listed = (await (
      await fetch(`${url}/api/agents/${aldric}/threads`, { headers: hub.headers })
    ).json()) as ReadonlyArray<Thread>;
    return listed.find((thread) => thread.id === chat)?.unread;
  };
  await expect.poll(unread, { timeout: 15_000 }).toBe(true);

  await page.goto(address);
  const card = main.getByRole("region", { name: "While you were away" });
  await expect(card).toContainText("Aldric · 2 updates");
  await expect(card).toContainText("1 new reply");
  await expect(card).toContainText("Ship on Fridays.");
  await expect(main.getByText(/^New since you left/)).toBeVisible();
  await expectAccessible(page, card);
  // Reading it marks the chat read on every device.
  await expect.poll(unread).toBe(false);
  await card.getByRole("button", { name: "Got it, fold this" }).click();
  await expect(card).toBeHidden();
  await expect(main.getByText("Caught up · 2 updates while you were away")).toBeVisible();
});
