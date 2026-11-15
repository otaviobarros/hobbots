import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
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

test("⌘K finds a thread by a word from its messages", async ({ page }) => {
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
