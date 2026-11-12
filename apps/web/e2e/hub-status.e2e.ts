import type { Browser, Page } from "@playwright/test";
import { admit, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { ticket } from "./quest-sheet.ts";

// Two devices following the same hub show the status it publishes (ADR 037), never one they work
// out themselves: a hob's presence in the sidebar, a thread's run in the chat header, and a Quest's
// progress on its pill.

let hub: Hub | undefined;
let dataDir = "";
let questing = false;

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  if (dataDir !== "") removeDataDir(dataDir);
  dataDir = "";
  if (questing) await stopQuestHub();
  questing = false;
});

const api = async <A>(current: Pick<Hub, "url" | "headers">, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A second device, admitted to the hub, with a page open at `path`. */
const secondDevice = async (
  browser: Browser,
  current: Hub | { url: string; headers: Hub["headers"] },
  path: string,
) => {
  const context = await browser.newContext();
  await admit(context, current as Hub);
  const page = await context.newPage();
  await page.goto(`${current.url}/#${path}`);
  return { page, close: () => context.close() };
};

/** A hub set up with one hob, Pip, on the fake runtime. */
const hirePip = async (current: Hub) => {
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  return api<{ id: string }>(current, "POST", "/api/agents", {
    name: "Pip",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
};

/** The line under the chat's title: whose chat it is and what the thread's run is doing. */
const headerSays = (page: Page, doing: string) => page.getByText(new RegExp(`^Your chat with Pip · ${doing}$`));

const hobTile = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: new RegExp(`^${name}, `) });

// The fake runtime writes one word every 40 ms and takes 600 ms to end a stopped turn.
const LONG_PROMPT = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
// Long enough for both devices to see the turn run: about 2.4 s.
const TURN_PROMPT = Array.from({ length: 60 }, (_, i) => `turn${i}`).join(" ");

// covers UX-002, CH-007
test("[TC-UX-1374-05] two devices show the same hob and thread status through a full turn and a stop", async ({
  page,
  browser,
}) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const current = hub;
  const pip = await hirePip(current);
  const thread = await api<{ id: string }>(current, "POST", `/api/agents/${pip.id}/threads`);
  const chat = `/hobs/${pip.id}/threads/${thread.id}`;
  await page.goto(`${current.url}/#${chat}`);
  const other = await secondDevice(browser, current, chat);
  const both = [page, other.page];
  for (const each of both) await expect(hobTile(each, "Pip")).toHaveAccessibleName("Pip, resting");

  // A full turn: both devices see Pip work while the reply streams, then rest once it ends.
  await api(current, "POST", `/api/threads/${thread.id}/messages`, { content: TURN_PROMPT });
  for (const each of both) {
    await expect(hobTile(each, "Pip")).toHaveAccessibleName("Pip, working");
    await expect(headerSays(each, "working")).toBeVisible();
  }
  for (const each of both) {
    await expect(each.getByText(`Echo: ${TURN_PROMPT}`)).toBeVisible();
    await expect(hobTile(each, "Pip")).toHaveAccessibleName("Pip, resting");
    await expect(headerSays(each, "ready")).toBeVisible();
  }

  // A stop on one device: both see it working, then resting once the stop lands.
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(LONG_PROMPT);
  await composer.press("Enter");
  for (const each of both) {
    await expect(each.getByText(/Echo: word0 word1 word2/)).toBeVisible();
    await expect(hobTile(each, "Pip")).toHaveAccessibleName("Pip, working");
    await expect(headerSays(each, "working")).toBeVisible();
  }
  await page.getByRole("button", { name: "■ Stop" }).click();
  for (const each of both) {
    await expect(each.getByText("■ You stopped this reply. Pip kept what it wrote so far.")).toBeVisible();
    await expect(hobTile(each, "Pip")).toHaveAccessibleName("Pip, resting");
    await expect(headerSays(each, "ready")).toBeVisible();
  }
  await other.close();
});

// covers UX-002, OR-004
test("[TC-UX-1374-06] two devices show the same quest progress and the same lead needing you through a quest step", async ({
  page,
  browser,
}) => {
  questing = true;
  const quest = await questHub();
  await page.goto(`${quest.url}/#/hobs/${quest.aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page).toHaveURL(/threads\//);
  const chat = new URL(page.url()).hash.slice(1);
  const other = await secondDevice(browser, quest, chat);
  const both = [page, other.page];

  // Ada's question climbs every lead: on both devices Aldric needs you and the pill counts it.
  for (const each of both) {
    const pill = each.getByRole("region", { name: "Work in progress" });
    await expect(pill).toContainText("1 needs you");
    await expect(pill).toContainText("of 2 done");
    await expect(ticket(each, "Plan the Black Friday campaign")).toContainText("1 needs you");
    await expect(hobTile(each, "Aldric")).toHaveAccessibleName("Aldric, needs you");
  }

  // The step: your answer on one device lets the Quest finish, and both devices follow it.
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  for (const each of both) {
    await expect(ticket(each, "Plan the Black Friday campaign")).toContainText("Finished in", { timeout: 30_000 });
    await expect(each.getByRole("region", { name: "Work in progress" })).toBeHidden();
    await expect(hobTile(each, "Aldric")).toHaveAccessibleName("Aldric, resting");
  }
  await other.close();
});

// covers UX-002
test("[TC-UX-1374-09] says when the hub's status cannot be read, keeps a paused hob paused, and reads it again", async ({
  page,
}) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const current = hub;
  const pip = await hirePip(current);
  await api(current, "POST", `/api/agents/${pip.id}/pause`);
  const failing = /\/api\/status$/;
  await page.route(failing, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(`${current.url}/#/`);

  // The read fails after its retries: the window says so, and Pip's own record still says paused.
  const notice = page.getByRole("alert").filter({ hasText: "could not read what your hobs and Quests are doing" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(hobTile(page, "Pip")).toHaveAccessibleName("Pip, paused");

  // The hub answers again: Try again reads it, and the notice goes.
  await page.unroute(failing);
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(notice).toBeHidden();
  await expect(hobTile(page, "Pip")).toHaveAccessibleName("Pip, paused");
});
