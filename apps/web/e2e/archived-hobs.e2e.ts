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

// covers AG-006
test("[TC-AG-061] a retired hob's threads open read-only from the Archive, which Settings › Archived hobs leads to", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  // A finished setup with one hob that chatted once and then retired.
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
  const thread = await api<{ id: string }>(current, "POST", `/agents/${hob.id}/threads`);
  await api(current, "POST", `/threads/${thread.id}/messages`, { content: "Plan my week" });
  await expect
    .poll(async () => {
      const messages = await api<Array<{ status: string }>>(current, "GET", `/threads/${thread.id}/messages`);
      return messages.map((m) => m.status);
    })
    .toEqual(["complete", "complete"]);
  await api(current, "POST", `/agents/${hob.id}/retire`, { activeWork: "finish" });

  // Settings › Archived hobs leads to the Archive's Retired hobs tab.
  await page.goto(`${current.url}/#/settings/archived`);
  await expect(page).toHaveURL(/#\/archive\?tab=hobs$/);
  const archive = page.getByRole("main", { name: "Archive" });
  await expect(archive.getByRole("tab", { name: /Retired hobs/ })).toHaveAttribute("aria-selected", "true");
  const card = archive.getByRole("list", { name: "Retired hobs" }).getByRole("listitem").filter({ hasText: "Pip" });
  await expect(card).toContainText("Guide");
  await expect(card).toContainText("1 chat kept");
  await expect(card).toContainText(/Retired .+/);

  // The card opens Pip's page: its chats, read-only, each opening on its own.
  await card.getByRole("link", { name: "Read Pip's chats" }).click();
  await expect(page).toHaveURL(new RegExp(`#/archive/hobs/${hob.id}$`));
  const retired = page.getByRole("main", { name: "Pip, retired" });
  await expect(retired.getByRole("heading", { name: "Pip" })).toBeVisible();
  await expect(retired).toContainText("Guide · retired");
  await expect(retired.getByRole("note")).toContainText("Pip is retired, so these chats are read-only");
  await retired.getByRole("link", { name: "Read Plan my week" }).click();

  await expect(page).toHaveURL(new RegExp(`#/archive/hobs/${hob.id}/${thread.id}$`));
  const chat = page.getByRole("main", { name: "Plan my week" });
  await expect(chat.getByText("Echo: Plan my week", { exact: true })).toBeVisible();
  await expect(chat.getByRole("note")).toHaveText(
    "Pip is retired, so this chat is read-only. It still shows up in search.",
  );
  await expect(page.getByRole("textbox")).toHaveCount(0);

  // The breadcrumb leads back, and Settings points to the Archive.
  await chat.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Retired hobs" }).click();
  await expect(page).toHaveURL(/#\/archive\?tab=hobs$/);
  await page.goto(`${current.url}/#/settings`);
  await page.getByRole("region", { name: "Archived hobs" }).getByRole("link", { name: "Open the Archive" }).click();
  await expect(page).toHaveURL(/#\/archive\?tab=hobs$/);
  expect(await api(current, "GET", "/agents")).toEqual([]);

  // An old address leads to the same chat, and one that pairs Pip with a thread Pip never had shows no transcript.
  await page.goto(`${current.url}/#/settings/archived/${hob.id}/threads/${thread.id}`);
  await expect(page).toHaveURL(new RegExp(`#/archive/hobs/${hob.id}/${thread.id}$`));
  await page.goto(`${current.url}/#/archive/hobs/${hob.id}/thread_not_pips`);
  await expect(page.getByText("This chat is not one of Pip's.")).toBeVisible();
  await expect(page.getByText("Echo: Plan my week", { exact: true })).toHaveCount(0);
});

// covers AG-006
test("[TC-AG-062] Retired hobs says so when no hob has retired", async ({ page }) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/setup", { completed: true });
  await page.goto(`${hub.url}/#/archive?tab=hobs`);
  const archive = page.getByRole("main", { name: "Archive" });
  await expect(archive.getByRole("heading", { name: "No retired hobs." })).toBeVisible();
  await expect(archive.getByRole("tab", { name: /Retired hobs/ })).toContainText("0");
});
