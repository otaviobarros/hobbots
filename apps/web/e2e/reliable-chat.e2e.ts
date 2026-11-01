import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, type Request, test } from "@playwright/test";
import { emptyDataDir, type Hub, type Relay, removeDataDir, startHub, startRelay } from "./hub.ts";

// The slice's done-when checks for reliable chat (#118), against a hub from source with the fake
// runtime. The hub's own suites check the same journal on SQLite and PostgreSQL.

let hub: Hub | undefined;
let relay: Relay | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await relay?.close();
  relay = undefined;
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

type Message = { readonly id: string; readonly role: string; readonly content: string; readonly status: string };

const call = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { origin: current.url, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as A;
};

const messagesOf = (current: Hub, threadId: string) =>
  call<ReadonlyArray<Message>>(current, "GET", `/threads/${threadId}/messages`);

/** Waits until every message of the thread has finished: no reply streaming, nothing queued. */
const settled = async (current: Hub, threadId: string) => {
  await expect
    .poll(async () =>
      (await messagesOf(current, threadId)).every((m) => !["streaming", "stopping", "queued"].includes(m.status)),
    )
    .toBe(true);
  return messagesOf(current, threadId);
};

// Longer than a thread title, so the title shows it shortened and only the message matches it whole.
const FIRST = "first, a message long enough that the thread's title has to shorten it";

/**
 * A finished setup, Lark the hob, and a thread with one exchange in it, open in a page that reaches
 * the hub through a relay the test can cut.
 */
const openThread = async (page: Page) => {
  const current = await startHub(dataDir);
  hub = current;
  await call(current, "PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const lark = await call<{ id: string }>(current, "POST", "/agents", {
    name: "Lark",
    role: null,
    roleTitle: "Courier",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 2604,
    lookColor: "moss",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  relay = await startRelay();
  await page.goto(`${relay.url}/#/hobs/${lark.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Lark/ });
  await composer.fill(FIRST);
  await composer.press("Enter");
  await expect(shown(page, `Echo: ${FIRST}`)).toBeVisible();
  const threadId = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  return { current, threadId, composer };
};

/** A message's own text in the page, matched whole so a streaming neighbour cannot match it. */
const shown = (page: Page, text: string) => chatView(page).getByText(text, { exact: true });

const chatView = (page: Page) => page.getByRole("main", { name: "Chat" });

/**
 * The page shows exactly the thread the hub holds: each message once, with the text the hub
 * stored, and nothing else that looks like a message of this thread.
 */
const showsExactly = async (page: Page, messages: ReadonlyArray<Message>) => {
  for (const message of messages) await expect(shown(page, message.content)).toHaveCount(1);
  await expect(chatView(page).getByText(/^Echo: /)).toHaveCount(messages.filter((m) => m.role === "assistant").length);
};

const reconnecting = (page: Page) => page.getByRole("status").filter({ hasText: "Reconnecting to Hobbots" });

/** Cuts the page off from the hub, as a sleeping laptop or a dropped Wi-Fi would, until `online`. */
const offline = async (page: Page) => {
  relay?.cut();
  await expect(reconnecting(page)).toBeVisible();
  return { online: () => relay?.restore() };
};

/** The cursors that the event streams the hub answers from now on resume after, read once asked. */
const streamCursors = (page: Page) => {
  const requests: Array<Request> = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/events")) requests.push(response.request());
  });
  // The browser sends Last-Event-ID itself when it reconnects, so only the full headers carry it.
  return () =>
    Promise.all(
      requests.map(async (request) => {
        const headers = await request.allHeaders();
        return headers["last-event-id"] ?? new URL(request.url()).searchParams.get("after") ?? undefined;
      }),
    );
};

/** Whether the page fetched the thread's messages again from now on: a full resync, not a replay. */
const refetches = (page: Page, threadId: string) => {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith(`/api/threads/${threadId}/messages`)) count += 1;
  });
  return () => count;
};

// The fake runtime writes one word every 40 ms, so this reply streams for about 2.4 seconds.
const LONG_PROMPT = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
const streamingReply = (page: Page, words: number) =>
  chatView(page).getByText(new RegExp(`^Echo: word0 .*\\bword${words}\\b`));

// covers CH-004, DP-003
test("[TC-CH-120] a hub killed mid-reply comes back with the reply interrupted, its saved text kept, and nothing shown twice", async ({
  page,
}) => {
  const { current, threadId, composer } = await openThread(page);
  await composer.fill(LONG_PROMPT);
  await composer.press("Enter");
  await expect(streamingReply(page, 30)).toBeVisible();
  const streamed = (await streamingReply(page, 30).textContent()) ?? "";

  await current.kill();
  await expect(reconnecting(page)).toBeVisible();
  hub = await startHub(dataDir);

  // The reply keeps the text the hub had saved, and says it was cut off by the restart.
  await expect(chatView(page).getByText(/This reply was cut off, not by you: Hobbots restarted/)).toHaveCount(1);
  await expect(reconnecting(page)).toBeHidden();
  const [, , prompt, reply] = await settled(hub, threadId);
  expect(prompt?.content).toBe(LONG_PROMPT);
  expect(reply?.status).toBe("interrupted");
  expect(reply?.content.startsWith("Echo: word0")).toBe(true);
  expect(streamed.startsWith(reply?.content ?? "")).toBe(true);
  test.info().annotations.push({
    type: "text lost in the crash",
    description: `${streamed.length - (reply?.content.length ?? 0)} of ${streamed.length} characters streamed`,
  });

  // The thread goes on, and every message is shown once with the text the hub stored.
  await composer.fill("after the crash");
  await composer.press("Enter");
  await expect(shown(page, "Echo: after the crash")).toBeVisible();
  const messages = await settled(hub, threadId);
  expect(messages.map((m) => [m.role, m.status])).toEqual([
    ["user", "complete"],
    ["assistant", "complete"],
    ["user", "complete"],
    ["assistant", "interrupted"],
    ["user", "complete"],
    ["assistant", "complete"],
  ]);
  await showsExactly(page, messages);
});

// covers CH-004, DP-003
test("[TC-CH-121] a page cut off mid-reply replays exactly what it missed when it reconnects", async ({ page }) => {
  const { current, threadId, composer } = await openThread(page);
  await composer.fill(LONG_PROMPT);
  await composer.press("Enter");
  await expect(streamingReply(page, 5)).toBeVisible();

  const network = await offline(page);
  const cursors = streamCursors(page);
  const refetched = refetches(page, threadId);
  // While the page is away the reply finishes, and another window sends a message that is answered.
  await expect
    .poll(async () => (await messagesOf(current, threadId)).at(-1)?.status, { timeout: 10_000 })
    .toBe("complete");
  await call(current, "POST", `/threads/${threadId}/messages`, { content: "sent from another window" });
  const messages = await settled(current, threadId);
  await network.online();

  await expect(reconnecting(page)).toBeHidden();
  await expect(shown(page, "Echo: sent from another window")).toBeVisible();
  await showsExactly(page, messages);
  expect(messages.map((m) => m.content)).toEqual([
    FIRST,
    `Echo: ${FIRST}`,
    LONG_PROMPT,
    `Echo: ${LONG_PROMPT}`,
    "sent from another window",
    "Echo: sent from another window",
  ]);
  // It resumed after its cursor: the stream replayed what was missed, nothing was fetched again.
  const resumedAfter = await cursors();
  expect(resumedAfter.length).toBeGreaterThan(0);
  expect(resumedAfter.every((cursor) => cursor !== undefined && cursor !== "")).toBe(true);
  expect(refetched()).toBe(0);
});

/** Deletes every journal entry but the latest, as compaction does once a client is away past retention. */
const compactJournal = (current: Hub) => {
  const database = new DatabaseSync(join(current.dataDir, "hobbots.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("DELETE FROM event_journal WHERE sequence < (SELECT MAX(sequence) FROM event_journal)");
  } finally {
    database.close();
  }
};

// covers CH-004, DP-003
test("[TC-CH-122] a page away past the journal's retention loads the thread again and shows each message once", async ({
  page,
}) => {
  const { current, threadId } = await openThread(page);
  // A long reply runs, and a message queued behind it reaches the page before the page goes away.
  await call(current, "POST", `/threads/${threadId}/messages`, { content: LONG_PROMPT });
  const queued = await call<{ userMessage: Message }>(current, "POST", `/threads/${threadId}/messages`, {
    content: "taken back",
  });
  expect(queued.userMessage.status).toBe("queued");
  await expect(shown(page, "taken back")).toHaveCount(1);

  const network = await offline(page);
  const refetched = refetches(page, threadId);
  // While the page is away: the queued message is taken back before it starts, and another is answered.
  await call(current, "DELETE", `/threads/${threadId}/messages/${queued.userMessage.id}`);
  await call(current, "POST", `/threads/${threadId}/messages`, { content: "still here" });
  const messages = await settled(current, threadId);
  compactJournal(current);
  await network.online();

  // The cursor can no longer be replayed, so the page starts over from the hub's state.
  await expect(reconnecting(page)).toBeHidden();
  await expect(shown(page, "Echo: still here")).toBeVisible();
  await expect.poll(refetched).toBeGreaterThan(0);
  // The page had the queued message cached; the hub's state, where it was taken back, replaces it.
  await expect(shown(page, "taken back")).toHaveCount(0);
  await showsExactly(page, messages);
  expect(messages.map((m) => m.content)).toEqual([
    FIRST,
    `Echo: ${FIRST}`,
    LONG_PROMPT,
    `Echo: ${LONG_PROMPT}`,
    "still here",
    "Echo: still here",
  ]);
});

const DATABASE_FILES = ["hobbots.sqlite", "hobbots.sqlite-wal", "hobbots.sqlite-shm"];

// covers CH-004, DP-003
test("[TC-CH-123] after a backup is restored the page shows the restored thread, not what it had cached", async ({
  page,
}) => {
  const { current, threadId, composer } = await openThread(page);
  await current.stop();
  const backup = join(dataDir, "backup");
  for (const file of DATABASE_FILES) {
    if (existsSync(join(dataDir, file))) copyFileSync(join(dataDir, file), `${backup}-${file}`);
  }
  hub = await startHub(dataDir);
  await expect(reconnecting(page)).toBeHidden();
  await composer.fill("after the backup");
  await composer.press("Enter");
  await expect(shown(page, "Echo: after the backup")).toBeVisible();
  await settled(hub, threadId);

  await hub.stop();
  for (const file of DATABASE_FILES) {
    rmSync(join(dataDir, file), { force: true });
    if (existsSync(`${backup}-${file}`)) copyFileSync(`${backup}-${file}`, join(dataDir, file));
  }
  const refetched = refetches(page, threadId);
  hub = await startHub(dataDir);

  await expect(reconnecting(page)).toBeHidden();
  await expect(shown(page, "Echo: after the backup")).toHaveCount(0);
  await expect.poll(refetched).toBeGreaterThan(0);
  const messages = await settled(hub, threadId);
  expect(messages.map((m) => m.content)).toEqual([FIRST, `Echo: ${FIRST}`]);
  await showsExactly(page, messages);
});
