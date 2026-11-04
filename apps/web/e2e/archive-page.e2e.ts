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

/** Starts a thread with one prompt and waits for the fake runtime's echo to finish. */
const thread = async (current: Hub, hobId: string, content: string) => {
  const created = await api<{ id: string }>(current, "POST", `/agents/${hobId}/threads`);
  await api(current, "POST", `/threads/${created.id}/messages`, { content });
  await expect
    .poll(async () => {
      const messages = await api<Array<{ status: string }>>(current, "GET", `/threads/${created.id}/messages`);
      return messages.map((m) => m.status);
    })
    .toEqual(["complete", "complete"]);
  return created;
};

/** Summons a hob with a name and role on a finished setup. */
const summon = (current: Hub, name: string, roleTitle: string, lookSeed: number) =>
  api<{ id: string }>(current, "POST", "/agents", {
    name,
    role: null,
    roleTitle,
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

// covers CH-006, CH-009
test("[TC-CH-215] the Archive lists every hob's archived chats, narrows to one hob and searches their messages", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  const pip = await summon(current, "Pip", "Writer", 7);
  const moss = await summon(current, "Moss", "Researcher", 11);
  const newsletter = await thread(current, pip.id, "Rename the newsletter");
  const pricing = await thread(current, moss.id, "Compare the summer pricing");
  await thread(current, moss.id, "Plan my week");
  await api(current, "POST", `/threads/${newsletter.id}/archive`);
  await api(current, "POST", `/threads/${pricing.id}/archive`);

  await page.goto(`${current.url}/#/archive`);
  const archive = page.getByRole("main", { name: "Archive" });
  await expect(archive.getByRole("heading", { name: "Archive", level: 1 })).toBeVisible();
  await expect(archive.getByRole("tab", { name: /Archived chats/ })).toContainText("2");
  const list = archive.getByRole("list", { name: "Archived chats" });
  // Most recently archived first, across both hobs; the live chat stays out.
  await expect(list.getByRole("listitem")).toHaveText([/Compare the summer pricing/, /Rename the newsletter/]);
  await expect(list.getByRole("listitem").first()).toContainText("Moss · Archived");

  // One hob's scope keeps its chats and lives in the address.
  await archive.getByRole("radio", { name: "Pip" }).click();
  await expect(page).toHaveURL(new RegExp(`#/archive\\?hob=${pip.id}$`));
  await expect(list.getByRole("listitem")).toHaveText([/Rename the newsletter/]);
  await archive.getByRole("radio", { name: "All hobs" }).click();
  await expect(page).toHaveURL(/#\/archive$/);

  // Search finds words in a chat's messages, not only in its title.
  const search = archive.getByRole("searchbox", { name: "Search archived chats" });
  await search.fill("echo summer");
  await expect(list.getByRole("listitem")).toHaveText([/Compare the summer pricing/]);
  await search.fill("lighthouse");
  await expect(archive.getByRole("heading", { name: "No archived chats mention “lighthouse”." })).toBeVisible();

  // Retired hobs is the other tab, with its own address.
  await archive.getByRole("tab", { name: /Retired hobs/ }).click();
  await expect(page).toHaveURL(/#\/archive\?tab=hobs$/);
  await expect(archive.getByRole("heading", { name: "No retired hobs." })).toBeVisible();
});
