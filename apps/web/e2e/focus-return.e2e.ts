import type { Locator, Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { questRoom, ticket } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Where focus lands when a screen takes away the element that had it: always on a visible,
// sensible element, never on the page itself (WCAG 2.4.3), and never under a sticky footer (2.4.11).

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await stopAldricHub();
  await hub?.stop();
  hub = undefined;
  if (dataDir !== "") removeDataDir(dataDir);
  dataDir = "";
});

/** Starts a hub with an empty data folder and Claude connected, with setup finished unless asked. */
const setUpHub = async (completed = true) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { ...(completed && { completed }), connectedProviders: ["claude-code"] });
  return hub;
};

/** Calls the hub's API and returns the decoded JSON body. */
const api = async <T>(current: Hub, method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

/** Whether nothing but the page itself has focus. */
const focusOnPage = (page: Page) =>
  page.evaluate(() => document.activeElement === null || document.activeElement === document.body);

/** Whether the element is inside the visible part of the window. */
const inView = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });

// covers UX-002, UX-006
test("[TC-UX-160] the room opened from the ticket by keyboard takes focus, and Close room puts it back in the chat", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Tidy the notes",
      'fake:write notes.md "# Notes\\n\\nTidied.\\n"',
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("complete_task", { delivered: true, key: "done", summary: "The notes are tidy." }),
    ].join("\n"),
  );
  await composer.press("Enter");
  const questTicket = ticket(page, "Tidy the notes");
  await expect(questTicket).toContainText("Finished in", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  // By keyboard: the ticket opens the room, and focus moves to its title.
  await questTicket.focus();
  await page.keyboard.press("Enter");
  const room = questRoom(page, "Tidy the notes");
  await expect(room.getByRole("heading", { name: "Tidy the notes" })).toBeFocused();

  // Close room, by keyboard, puts focus back in the chat's message box.
  await room.getByRole("button", { name: "Close room" }).focus();
  await page.keyboard.press("Enter");
  await expect(room).toBeHidden();
  await expect(composer).toBeFocused();
  expect(await focusOnPage(page)).toBe(false);
});

/** Archives one chat per title for a hob, each with its echoed reply, oldest first. */
const archivedChats = async (current: Hub, hobId: string, titles: ReadonlyArray<string>) => {
  for (const title of titles) {
    const created = await api<{ id: string }>(current, "POST", `/agents/${hobId}/threads`);
    await api(current, "POST", `/threads/${created.id}/messages`, { content: title });
    await expect
      .poll(async () =>
        (await api<Array<{ status: string }>>(current, "GET", `/threads/${created.id}/messages`)).map((m) => m.status),
      )
      .toEqual(["complete", "complete"]);
    await api(current, "POST", `/threads/${created.id}/archive`);
  }
};

// covers CH-009
test("[TC-CH-280] after Restore in the Archive, focus moves to the next row's Restore, then the one before, then the empty list", async ({
  page,
}) => {
  const current = await setUpHub();
  const pip = await api<{ id: string }>(current, "POST", "/agents", {
    name: "Pip",
    role: null,
    roleTitle: "Writer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 7,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  // Most recently archived first: Plan the week, Rename the newsletter, Compare the pricing.
  await archivedChats(current, pip.id, ["Compare the pricing", "Rename the newsletter", "Plan the week"]);

  await page.goto(`${current.url}/#/archive`);
  const archive = page.getByRole("main", { name: "Archive" });
  const list = archive.getByRole("list", { name: "Archived chats" });
  const restore = (title: string) => list.getByRole("button", { name: `Restore “${title}”` });
  await expect(list.getByRole("listitem")).toHaveText([
    /Plan the week/,
    /Rename the newsletter/,
    /Compare the pricing/,
  ]);

  // A row in the middle: focus moves to the row that takes its place.
  await restore("Rename the newsletter").focus();
  await page.keyboard.press("Enter");
  await expect(list.getByRole("listitem")).toHaveText([/Plan the week/, /Compare the pricing/]);
  await expect(restore("Compare the pricing")).toBeFocused();

  // The last row: focus moves to the one before.
  await page.keyboard.press("Enter");
  await expect(list.getByRole("listitem")).toHaveText([/Plan the week/]);
  await expect(restore("Plan the week")).toBeFocused();

  // The only row: focus moves to the empty list's heading.
  await page.keyboard.press("Enter");
  await expect(archive.getByRole("heading", { name: "Nothing archived yet." })).toBeFocused();
  expect(await focusOnPage(page)).toBe(false);
});

// covers OP-001
test("[TC-OP-080] First run keeps the focused field clear of its sticky footer and starts each step on its heading", async ({
  page,
}) => {
  const current = await setUpHub(false);
  // A short window, so the step scrolls under its footer.
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto(`${current.url}/#/setup/hob`);
  const main = page.getByRole("main");
  await expect(page.getByRole("heading", { name: "Who should help you first?" })).toBeVisible();
  const footer = main.locator("footer");

  // Tab through every control above the footer: none ends up hidden beneath it.
  await page.getByRole("heading", { name: "Who should help you first?" }).focus();
  for (let step = 0; step < 30; step++) {
    await page.keyboard.press("Tab");
    const covered = await page.evaluate(() => {
      const focused = document.activeElement;
      const bar = document.querySelector("main footer");
      if (!(focused instanceof HTMLElement) || bar === null || bar.contains(focused)) return false;
      if (focused.closest("aside") !== null) return false;
      return focused.getBoundingClientRect().bottom > bar.getBoundingClientRect().top + 1;
    });
    expect(covered, `Tab ${step + 1} lands under the footer`).toBe(false);
  }
  await expect(footer).toBeVisible();

  // Continue by keyboard: the next step opens with focus on its heading, in view.
  await page.getByRole("textbox", { name: "Hob name" }).fill("Pip");
  await footer.getByRole("button", { name: "Continue" }).focus();
  await page.keyboard.press("Enter");
  const next = page.getByRole("heading", { name: "How careful should your hobs be?" });
  await expect(next).toBeFocused();
  expect(await inView(next)).toBe(true);
});

// covers AG-001
test("[TC-AG-120] Summon's next step opens at its top with focus on its heading", async ({ page }) => {
  const current = await setUpHub();
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(`${current.url}/#/summon`);
  await expect(page.getByRole("heading", { name: "What should your new hob help you with?" })).toBeVisible();

  // Scrolled down to its Next button, the role step moves on by keyboard.
  const next = page.getByRole("button", { name: "Next: name and look" });
  await next.focus();
  const main = page.getByRole("main");
  expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/step=look/);
  const heading = page.getByRole("heading", { name: /^Give .+ a name, a look and a voice$/ });
  await expect(heading).toBeFocused();
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await inView(heading)).toBe(true);

  // Back to the role step works the same way.
  await page.getByRole("button", { name: "Back", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "What should your new hob help you with?" })).toBeFocused();
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
});
