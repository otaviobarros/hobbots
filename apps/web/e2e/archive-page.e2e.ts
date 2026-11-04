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
  // Each row shows the chat's last line.
  await expect(list.getByRole("listitem").first()).toContainText("Echo: Compare the summer pricing");

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

/** Asks the hub to archive one chat per title for a hob, then waits until every reply has finished. */
const archivedChats = async (current: Hub, hobId: string, titles: ReadonlyArray<string>) => {
  const made = await Promise.all(
    titles.map(async (title) => {
      const created = await api<{ id: string }>(current, "POST", `/agents/${hobId}/threads`);
      await api(current, "POST", `/threads/${created.id}/messages`, { content: title });
      return created.id;
    }),
  );
  for (const id of made) {
    await expect
      .poll(async () =>
        (await api<Array<{ status: string }>>(current, "GET", `/threads/${id}/messages`)).map((m) => m.status),
      )
      .toEqual(["complete", "complete"]);
    await api(current, "POST", `/threads/${id}/archive`);
  }
};

/** Whether the page scrolls sideways. */
const overflows = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

// covers CH-009
test("[TC-CH-240] the Archive holds 46 chats across eight hobs, one with a very long name", async ({ page }) => {
  test.setTimeout(180_000);
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  const long = "Bartholomew Thistlewood-Fairweather III";
  const names = [long, "Pip", "Moss", "Juniper", "Wren", "Fennel", "Quill", "Tansy"];
  // Most chats first: 13, 9, 7, 6, 4, 3, 2, 2 (46 in all), so Quill and Tansy go under More hobs.
  const counts = [13, 9, 7, 6, 4, 3, 2, 2];
  const hobs = [];
  for (const [n, name] of names.entries()) hobs.push(await summon(current, name, "Helper", n + 3));
  for (const [n, hob] of hobs.entries()) {
    const titles = Array.from(
      { length: counts[n] ?? 0 },
      (_, k) =>
        `${names[n]} chat ${k + 1}${k === 0 ? ", about a very long subject that needs more than one line" : ""}`,
    );
    await archivedChats(current, hob.id, titles);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${current.url}/#/archive`);
  const archive = page.getByRole("main", { name: "Archive" });
  await expect(archive.getByRole("tab", { name: /Archived chats/ })).toContainText("46");
  const scope = archive.getByRole("radiogroup", { name: "Whose chats" });
  await expect(scope.getByRole("radio")).toHaveCount(7);
  await expect(scope.getByRole("radio", { name: "All hobs" })).toContainText("46");
  await expect(scope.getByRole("radio", { name: new RegExp(`^${long}`) })).toContainText("13");
  const list = archive.getByRole("list", { name: "Archived chats" });
  await expect(list.getByRole("listitem")).toHaveCount(12);
  expect(await overflows(page)).toBe(false);

  // Show 34 more opens the rest.
  await archive.getByRole("button", { name: "Show 34 more" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(46);
  expect(await overflows(page)).toBe(false);

  // More hobs holds the last two by name; one picked there becomes the picked chip.
  await archive.getByRole("button", { name: /More hobs/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([/Quill\s*2/, /Tansy\s*2/]);
  await menu.getByRole("menuitem", { name: /Tansy/ }).click();
  const tansy = hobs[7]?.id ?? "";
  await expect(page).toHaveURL(new RegExp(`#/archive\\?hob=${tansy}$`));
  await expect(scope.getByRole("radio", { name: /^Tansy/ })).toHaveAttribute("aria-checked", "true");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await archive.getByRole("button", { name: /More hobs/ }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([/Quill\s*2/]);
  await page.keyboard.press("Escape");

  // On a phone the chips wrap and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await scope.getByRole("radio", { name: new RegExp(`^${long}`) }).click();
  await expect(list.getByRole("listitem")).toHaveCount(12);
  expect(await overflows(page)).toBe(false);
  await archive.getByRole("tab", { name: /Retired hobs/ }).click();
  expect(await overflows(page)).toBe(false);
});

// covers CH-009, AG-006
test("[TC-CH-241] an empty Archive says how to archive, and a long retired hob's name holds on its card", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${current.url}/#/archive`);
  const archive = page.getByRole("main", { name: "Archive" });
  await expect(archive.getByRole("heading", { name: "Nothing archived yet." })).toBeVisible();
  await expect(archive).toContainText("To archive a chat, open its ⋯ menu and pick Archive");
  await expect(archive.getByRole("radiogroup", { name: "Whose chats" })).toHaveCount(0);
  expect(await overflows(page)).toBe(false);

  const long = "Bartholomew Thistlewood-Fairweather III";
  const hob = await summon(current, long, "Bookkeeper of the long, winding ledger", 5);
  await api(current, "POST", `/agents/${hob.id}/retire`, { activeWork: "finish" });
  await page.goto(`${current.url}/#/archive?tab=hobs`);
  const card = archive.getByRole("list", { name: "Retired hobs" }).getByRole("listitem");
  await expect(card.getByRole("link", { name: `Read ${long}'s chats` })).toBeVisible();
  await expect(card.getByRole("button", { name: `Bring back ${long}` })).toBeVisible();
  expect(await overflows(page)).toBe(false);
  const box = await card.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
});
