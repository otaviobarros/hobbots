import { expectAccessible } from "./accessibility.ts";
import { expandSidebar, expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1378 (ADR 037): the hob's chat and its camps in the browser, on the fake runtime. The
// sidebar lists the hob's Chat, then its camps; Make a camp and Start fresh open their sheets from
// the sidebar and the chat's ⋯ menu.

test.afterEach(stopAldricHub);
test.beforeEach(({ context }) => expandSidebar(context));

const AWAY = /^Send( after this reply)?$/;

// covers CH-001, CH-009
test("[TC-CH-1378-02] makes a private camp with a goal, sends in it, and archives and restores it", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  const header = main.locator("header").first();
  const rail = page.getByRole("list", { name: "Aldric's chat and camps" });

  // Opening the hob opens its chat, which leads with the hob's name.
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await expect(header).toContainText("Aldric");
  await expect(header.getByRole("link", { name: "Your chat with Aldric" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message Aldric…" });
  await composer.fill("first");
  await composer.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
  await expect(main.getByText("Echo: first")).toBeVisible();
  const chatAddress = page.url();
  await expect(rail.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");

  // Make a camp from the sidebar: a name is needed, and the camp opens once it is made.
  await rail.getByRole("button", { name: "Make a camp for Aldric" }).click();
  const sheet = page.getByRole("dialog", { name: "Make a camp" });
  await expectAccessible(page, sheet);
  await sheet.getByRole("button", { name: "Make the camp" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Give the camp a name.");
  await sheet.getByRole("textbox", { name: "Name" }).fill("2027 taxes");
  await sheet.getByRole("textbox", { name: "Goal" }).fill("File my taxes on time");
  await sheet.getByRole("switch", { name: "Private camp" }).click();
  await expect(sheet).toContainText("Nothing said here goes into Aldric's memory.");
  await sheet.getByRole("button", { name: "Make the camp" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(chatAddress);
  await expect(header).toContainText("2027 taxes");
  await expect(header).toContainText("Goal: File my taxes on time");
  await expect(rail.getByRole("link")).toHaveText(["✦Chat", "⛺2027 taxes"]);
  await expect(rail.getByRole("link", { name: "2027 taxes" })).toHaveAttribute("aria-current", "page");
  const listed = (await (
    await fetch(`${url}/api/agents/${aldric}/threads`, { headers: hub.headers })
  ).json()) as ReadonlyArray<{ readonly title: string }>;
  expect(listed.find((thread) => thread.title === "2027 taxes")).toMatchObject({
    kind: "camp",
    goal: "File my taxes on time",
    private: true,
  });

  // A message in the camp stays in the camp.
  const inCamp = page.getByRole("textbox", { name: "Message Aldric in “2027 taxes”…" });
  await inCamp.fill("receipts");
  await expect(page.getByRole("button", { name: AWAY })).toBeEnabled();
  await inCamp.press("Enter");
  await expect(main.getByText("Echo: receipts")).toBeVisible();
  await rail.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(chatAddress);
  await expect(main.getByText("Echo: receipts")).toBeHidden();

  // Archive the camp from its menu, then Undo brings it back to the sidebar.
  await rail.getByRole("link", { name: "2027 taxes" }).click();
  await header.getByRole("button", { name: "More for this chat" }).click();
  await page.getByRole("menuitem", { name: "Archive chat" }).click();
  await expect(rail.getByRole("link", { name: "2027 taxes" })).toBeHidden();
  await page.getByRole("button", { name: "Undo archive of 2027 taxes" }).click();
  await expect(rail.getByRole("link", { name: "2027 taxes" })).toBeVisible();
});

// covers CH-009, IN-001
test("[TC-CH-1378-03] starts the chat fresh from its menu, and the open question carries over to the new chat", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  const header = main.locator("header").first();

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: "Message Aldric…" });
  await composer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Aldric asks you" })).toContainText("Should the headings be short?");
  const oldChat = page.url();

  // The sheet lists what comes along and how many items move, before anything changes.
  await header.getByRole("button", { name: "More for this chat" }).click();
  await page.getByRole("menuitem", { name: "Start a fresh chat" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a fresh chat with Aldric" });
  await expect(sheet).toContainText("2 open items move to the new chat, so nothing is dropped.");
  await expect(sheet.getByRole("listitem")).toHaveText([
    // An open Task reads as its brief, which is the whole message that started it.
    /^Tidy the notes .*Open work$/,
    "Should the headings be short?A question waiting for an answer",
  ]);
  await expectAccessible(page, sheet);
  await sheet.getByRole("button", { name: "Archive and start fresh" }).click();
  await expect(sheet).toBeHidden();

  // The new chat opens with the question still waiting there, and the old one went to the Archive.
  await expect(page).not.toHaveURL(oldChat);
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
  // The old messages stay behind; the Quest they started comes along with its question.
  await expect(main.getByText(/fake:hub start_quest/)).toBeHidden();
  await expect(page.getByRole("region", { name: "Aldric asks you" })).toContainText("Should the headings be short?");
  const rail = page.getByRole("list", { name: "Aldric's chat and camps" });
  await expect(rail.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
  const archived = (await (
    await fetch(`${url}/api/agents/${aldric}/threads?archived=true`, { headers: hub.headers })
  ).json()) as ReadonlyArray<{ readonly id: string; readonly state: string }>;
  expect(archived.map((thread) => thread.state)).toEqual(["superseded"]);
  expect(oldChat).toContain(archived[0]?.id);
});
