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
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

// covers AG-006
test("[TC-AG-061] a retired hob's threads open read-only from Settings › Archived hobs", async ({ page }) => {
  hub = await startHub(dataDir);
  const current = hub;
  // A finished setup with one hob that chatted once and then retired.
  await api(current, "PATCH", "/setup", { completed: true });
  const hob = await api<{ id: string }>(current, "POST", "/agents", {
    name: "Pip",
    craft: "Guide",
    lookSeed: 7,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  const thread = await api<{ id: string }>(current, "POST", `/agents/${hob.id}/threads`);
  await api(current, "POST", `/threads/${thread.id}/messages`, { content: "Plan my week" });
  await expect
    .poll(async () => {
      const messages = await api<Array<{ status: string }>>(current, "GET", `/threads/${thread.id}/messages`);
      return messages.map((m) => m.status);
    })
    .toEqual(["complete", "complete"]);
  await api(current, "POST", `/agents/${hob.id}/retire`, { activeWork: "finish" });

  await page.goto(`${current.url}/#/settings/archived`);
  await expect(page.getByRole("heading", { name: "Archived hobs" })).toBeVisible();
  const archived = page.getByRole("region", { name: "Archived hobs" });
  const row = archived.getByRole("listitem").filter({ hasText: "Pip" });
  await expect(row).toContainText(/Guide · retired .+ · 1 chat kept/);

  await row.getByRole("link", { name: "Read Pip's chats" }).click();
  await expect(page).toHaveURL(new RegExp(`#/settings/archived/${hob.id}/threads/${thread.id}$`));
  const chat = page.getByRole("main", { name: "Chat" });
  // The thread's title in the header and the user's message both read "Plan my week".
  await expect(chat.getByText("Plan my week", { exact: true })).toHaveCount(2);
  await expect(chat.getByText("Echo: Plan my week", { exact: true })).toBeVisible();
  await expect(chat.getByRole("note")).toHaveText("Pip is retired, so this chat is read-only.");
  await expect(page.getByRole("textbox")).toHaveCount(0);

  // The thread list leads back to Archived hobs.
  await page.getByRole("link", { name: "‹ Archived hobs" }).click();
  await expect(page).toHaveURL(/#\/settings\/archived$/);
  // Settings lists the same hob, and its active hob list no longer does.
  await page.getByRole("link", { name: "‹ All settings" }).click();
  await expect(page.getByRole("region", { name: "Archived hobs" }).getByText("Pip", { exact: true })).toBeVisible();
  expect(await api(current, "GET", "/agents")).toEqual([]);

  // A link that pairs Pip with a thread Pip never had shows no transcript.
  await page.goto(`${current.url}/#/settings/archived/${hob.id}/threads/thread_not_pips`);
  await expect(page.getByText("This chat is not one of Pip's.")).toBeVisible();
  await expect(page.getByText("Echo: Plan my week", { exact: true })).toHaveCount(0);
});

// covers AG-006
test("[TC-AG-062] Archived hobs says so when no hob has retired", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });
  await page.goto(`${hub.url}/#/settings`);
  await expect(page.getByRole("region", { name: "Archived hobs" })).toContainText("No retired hobs.");
});
