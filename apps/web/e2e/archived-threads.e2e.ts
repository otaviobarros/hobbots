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

/** A finished setup with one hob and two threads, the older of them archived. */
const hubWithArchive = async () => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true });
  const hob = await api<{ id: string }>(current, "POST", "/agents", {
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
  const archived = await thread(current, hob.id, "Rename the newsletter");
  const live = await thread(current, hob.id, "Plan my week");
  await api(current, "POST", `/threads/${archived.id}/archive`);
  return { current, hob, archived, live };
};

// covers CH-009
test("[TC-CH-160] an archived thread opens read-only from the hob's Archived list and comes back on Restore", async ({
  page,
}) => {
  const { current, hob, archived } = await hubWithArchive();
  await page.goto(`${current.url}/#/hobs/${hob.id}`);

  const nav = page.getByRole("navigation", { name: "Hobs and threads" });
  await expect(nav.getByRole("link", { name: /Plan my week/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Rename the newsletter/ })).toHaveCount(0);
  await expect(nav).toContainText("Writer· 1 thread");
  await nav.getByRole("link", { name: "Archived, 1 thread" }).click();

  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob.id}/archived$`));
  const list = page.getByRole("list", { name: "Archived threads" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("archived just now · last message");
  await list.getByRole("link", { name: /Rename the newsletter/ }).click();

  // Read-only: the Archived banner with Restore, the transcript, and no composer.
  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob.id}/threads/${archived.id}`));
  const chat = page.getByRole("main", { name: "Chat" });
  await expect(chat.getByRole("region", { name: "Archived" })).toContainText("Pip takes no new messages here");
  await expect(chat.getByText("Echo: Rename the newsletter", { exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox")).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Archived, 1 thread" })).toHaveAttribute("aria-current", "page");

  await chat.getByRole("button", { name: "Restore “Rename the newsletter”" }).click();

  // Restored: back in the hob's list, and it takes messages again.
  await expect(nav.getByRole("link", { name: /Rename the newsletter/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Archived/ })).toHaveCount(0);
  const composer = chat.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("Try a shorter name");
  await composer.press("Enter");
  await expect(chat.getByText("Echo: Try a shorter name", { exact: true })).toBeVisible();
});

// covers CH-009
test("[TC-CH-161] restoring the last archived thread from the list leaves the empty state", async ({ page }) => {
  const { current, hob } = await hubWithArchive();
  await page.goto(`${current.url}/#/hobs/${hob.id}/archived`);

  await page.getByRole("button", { name: "Restore “Rename the newsletter”" }).click();

  const main = page.getByRole("main", { name: "Archived threads" });
  await expect(main.getByRole("region", { name: "No archived threads" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Hobs and threads" });
  await expect(nav.getByRole("link", { name: /Rename the newsletter/ })).toBeVisible();
  await main.getByRole("link", { name: "‹ Back to Pip's threads" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob.id}/threads/`));
});

// covers CH-006, CH-009
test("[TC-CH-162] search marks an archived thread and opens it read-only", async ({ page }) => {
  const { current, hob, archived } = await hubWithArchive();
  await page.goto(`${current.url}/#/hobs/${hob.id}`);

  await page.getByRole("searchbox", { name: "Search hobs, threads and messages" }).fill("newsletter");
  const result = page.getByRole("link", { name: /Rename the newsletter/ });
  await expect(result).toContainText("Archived");
  await result.click();

  await expect(page).toHaveURL(new RegExp(`#/hobs/${hob.id}/threads/${archived.id}\\?message=`));
  const chat = page.getByRole("main", { name: "Chat" });
  await expect(chat.getByRole("region", { name: "Archived" })).toBeVisible();
  await expect(chat.getByRole("textbox")).toHaveCount(0);
});

/** The hub's answer for a hob's archived threads, which these cases hold back or refuse. */
const archivedList = /\/api\/agents\/[^/]+\/threads\?archived=true$/;

// covers CH-009
test("[TC-CH-163] an archived thread opened by its address shows no composer while its lists load", async ({
  page,
}) => {
  const { current, hob, archived } = await hubWithArchive();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(archivedList, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${current.url}/#/hobs/${hob.id}/threads/${archived.id}`);

  const chat = page.getByRole("main", { name: "Chat" });
  await expect(chat.getByRole("status")).toHaveText("Opening the thread…");
  await expect(chat.getByRole("textbox")).toHaveCount(0);

  release();
  await expect(chat.getByRole("region", { name: "Archived" })).toBeVisible();
  await expect(chat.getByRole("textbox")).toHaveCount(0);
});

// covers CH-009
test("[TC-CH-164] an archived thread whose lookup fails stays without a composer until Try again", async ({ page }) => {
  const { current, hob, archived } = await hubWithArchive();
  await page.route(archivedList, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(`${current.url}/#/hobs/${hob.id}/threads/${archived.id}`);

  const chat = page.getByRole("main", { name: "Chat" });
  // The client asks again a few times before it gives up.
  await expect(chat.getByRole("alert")).toContainText("could not tell whether this thread is archived", {
    timeout: 20_000,
  });
  await expect(chat.getByRole("textbox")).toHaveCount(0);

  await page.unroute(archivedList);
  await chat.getByRole("button", { name: "Try again" }).click();
  await expect(chat.getByRole("region", { name: "Archived" })).toBeVisible();
  await expect(chat.getByRole("textbox")).toHaveCount(0);
});
