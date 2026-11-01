import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** Calls the hub's API and returns the decoded JSON body. */
const api = async <T>(current: Hub, method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { origin: current.url, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

/** Sends prompts, which queue and run in order, and waits for the fake runtime's echoes to finish. */
const chat = async (current: Hub, threadId: string, ...contents: ReadonlyArray<string>) => {
  for (const content of contents) await api(current, "POST", `/threads/${threadId}/messages`, { content });
  await expect
    .poll(
      async () => {
        const messages = await api<Array<{ status: string }>>(current, "GET", `/threads/${threadId}/messages`);
        return messages.length === contents.length * 2 && messages.every((m) => m.status === "complete");
      },
      // The thirteen turns of the history take about five seconds, the default poll timeout.
      { timeout: 20_000 },
    )
    .toBe(true);
};

/** A finished setup with one hob, an old thread that once mentioned lanterns, and a newer busy one. */
const hubWithHistory = async () => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  const hob = await api<{ id: string }>(current, "POST", "/agents", {
    name: "Pip",
    role: null,
    roleTitle: "Guide",
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
  const old = await api<{ id: string }>(current, "POST", `/agents/${hob.id}/threads`);
  // Enough later talk in the same thread that the lantern message starts out of sight. The notes
  // are tall but have few spaces, since the fake runtime streams its echo a word every 40 ms.
  const notes = Array.from({ length: 12 }, (_, turn) => `Note ${turn + 1}:\n${"Water-the-plants.\n".repeat(12)}`);
  await chat(current, old.id, "Where did I put the lanterns?", ...notes);
  const recent = await api<{ id: string }>(current, "POST", `/agents/${hob.id}/threads`);
  await chat(current, recent.id, "Plan my week");
  return { current, hob, old, recent };
};

// covers CH-006
test("[TC-CH-065] a word from an old message finds its thread in the hob panel and opens it at the match", async ({
  page,
}) => {
  const { current, hob, old, recent } = await hubWithHistory();
  await page.goto(`${current.url}/#/hobs/${hob.id}/threads/${recent.id}`);

  const search = page.getByRole("searchbox", { name: "Search hobs, threads and messages" });
  await search.fill("lantern");
  await expect(page.getByRole("status").filter({ hasText: "result" })).toHaveText("1 result");
  const result = page.getByRole("link", { name: /Where did I put the lanterns\?/ });
  await expect(result).toContainText("Pip · ");
  await expect(result).toContainText("2 matches");
  await result.click();

  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob.id}/threads/${old.id}\\?message=`));
  await expect(search).toHaveValue("");
  const chatView = page.getByRole("main", { name: "Chat" });
  // The newest match, the echo of the lantern question, scrolls into view.
  await expect(chatView.getByText("Echo: Where did I put the lanterns?", { exact: true })).toBeInViewport();
});

// covers CH-006
test("[TC-CH-066] ⌘K finds a thread by a word from its messages", async ({ page }) => {
  const { current, hob, old } = await hubWithHistory();
  await page.goto(`${current.url}/#/usage`);
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const finder = page.getByRole("dialog", { name: "Jump anywhere" });
  await finder.getByRole("combobox", { name: "Find a hob, thread or message" }).fill("lanterns");
  await expect(finder.getByRole("option")).toHaveCount(1);
  await expect(finder.getByRole("option")).toContainText("Where did I put the lanterns?");
  await page.keyboard.press("Enter");

  await expect(finder).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob.id}/threads/${old.id}\\?message=`));
});

// covers CH-006
test("[TC-CH-069] a reply streaming into the thread keeps the search match in view", async ({ page }) => {
  const { current, hob, old, recent } = await hubWithHistory();
  await page.goto(`${current.url}/#/hobs/${hob.id}/threads/${recent.id}`);
  // A long reply starts streaming into the old thread, a word every 40 ms, for several seconds.
  await api(current, "POST", `/threads/${old.id}/messages`, { content: "more ".repeat(150) });

  await page.getByRole("searchbox", { name: "Search hobs, threads and messages" }).fill("lantern");
  await page.getByRole("link", { name: /Where did I put the lanterns\?/ }).click();
  const chatView = page.getByRole("main", { name: "Chat" });
  const match = chatView.getByText("Echo: Where did I put the lanterns?", { exact: true });
  const stop = page.getByRole("button", { name: "■ Stop" });
  await expect(stop).toBeVisible();
  await expect(match).toBeInViewport();
  // Words keep arriving, and the match stays put.
  await page.waitForTimeout(1500);
  await expect(stop).toBeVisible();
  await expect(match).toBeInViewport();

  // Scrolling back down to the end follows the reply again.
  const reply = chatView.getByText(/^Echo: more more/);
  await reply.hover();
  await page.mouse.wheel(0, 100_000);
  await expect(stop).toBeHidden({ timeout: 15_000 });
  await expect(match).not.toBeInViewport();
  await expect(reply).toBeInViewport();
});
