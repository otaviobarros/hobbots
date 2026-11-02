import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// The archive slice's done-when journey as the user sees it, with the fake runtime: archive from the
// thread's menu, find it in the Archived list and in search, read it with no composer, restore it.
// Archiving refused while a reply runs or an approval waits is `[TC-CH-152]` and `[TC-CH-156]`; the
// hub-level checks on SQLite and PostgreSQL are in apps/server/test/archive-end-to-end.test.ts.
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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A finished setup with Pip, a hob thinking with the fake runtime. */
const summonPip = async (current: Hub) => {
  await api(current, "PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  return api<{ id: string }>(current, "POST", "/agents", {
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

const threadList = (page: Page) => page.getByRole("navigation", { name: "Hobs and threads" });
const threadLink = (page: Page, title: string) => threadList(page).getByRole("link", { name: new RegExp(`^${title}`) });

/** Starts a new thread with Pip from the composer and waits for its echo. */
const chat = async (page: Page, current: Hub, pipId: string, prompt: string) => {
  await page.goto(`${current.url}/#/hobs/${pipId}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible();
  await expect(threadLink(page, prompt)).toBeVisible();
};

// covers CH-006, CH-009
test("[TC-CH-157] a thread archived from its menu is found in the Archived list and in search, opens read-only and comes back on Restore", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  const pip = await summonPip(current);
  await chat(page, current, pip.id, "Rename the newsletter");
  await chat(page, current, pip.id, "Plan my week");

  // Archive it from its row's menu: it leaves the hob's list.
  await page.getByRole("button", { name: "More for “Rename the newsletter”" }).click();
  await page.getByRole("menuitem", { name: /Archive thread/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archived “Rename the newsletter”." })).toBeVisible();
  await expect(threadLink(page, "Rename the newsletter")).toHaveCount(0);
  await expect(threadLink(page, "Plan my week")).toBeVisible();

  // Found in the hob's Archived list, and it opens read-only.
  await threadList(page).getByRole("link", { name: "Archived, 1 thread" }).click();
  const archived = page.getByRole("list", { name: "Archived threads" });
  await expect(archived.getByRole("listitem")).toHaveCount(1);
  await archived.getByRole("link", { name: /Rename the newsletter/ }).click();
  const main = page.getByRole("main", { name: "Chat" });
  await expect(main.getByRole("region", { name: "Archived" })).toContainText("Pip takes no new messages here");
  await expect(main.getByText("Echo: Rename the newsletter", { exact: true })).toBeVisible();
  await expect(main.getByRole("textbox")).toHaveCount(0);

  // Found by search too, marked archived, and it opens read-only from there.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await page.getByRole("searchbox", { name: "Search hobs, threads and messages" }).fill("newsletter");
  const result = page.getByRole("link", { name: /Rename the newsletter/ });
  await expect(result).toContainText("Archived");
  await result.click();
  await expect(main.getByRole("region", { name: "Archived" })).toBeVisible();
  await expect(main.getByRole("textbox")).toHaveCount(0);

  // Restore: back in the hob's list with its history, and it takes messages again.
  await main.getByRole("button", { name: "Restore “Rename the newsletter”" }).click();
  await expect(threadLink(page, "Rename the newsletter")).toBeVisible();
  await expect(threadList(page).getByRole("link", { name: /^Archived/ })).toHaveCount(0);
  await expect(main.getByText("Echo: Rename the newsletter", { exact: true })).toBeVisible();
  const composer = main.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("Try a shorter name");
  await composer.press("Enter");
  await expect(main.getByText("Echo: Try a shorter name", { exact: true })).toBeVisible();
});
