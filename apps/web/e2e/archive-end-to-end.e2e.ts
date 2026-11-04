import type { Page } from "@playwright/test";
import { emptyDataDir, expandSidebar, expect, type Hub, removeDataDir, sidebarThread, startHub, test } from "./hub.ts";

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

// The open hob's threads show under it in the expanded sidebar.
test.beforeEach(({ context }) => expandSidebar(context));
const threadLink = sidebarThread;

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
test("[TC-CH-157] a thread archived from its menu is found in the Archive and in search, opens read-only and comes back on Restore", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  const pip = await summonPip(current);
  await chat(page, current, pip.id, "Rename the newsletter");
  await chat(page, current, pip.id, "Plan my week");

  // Archive it from its row's menu on the hob's page: it leaves the hob's lists.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  const chats = page.getByRole("main", { name: "Pip's page" });
  await chats.getByRole("button", { name: "More for “Rename the newsletter”" }).click();
  await page.getByRole("menuitem", { name: /Archive thread/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archived “Rename the newsletter”." })).toBeVisible();
  await expect(chats.getByRole("link", { name: "Open Rename the newsletter" })).toHaveCount(0);
  await expect(threadLink(page, "Rename the newsletter")).toHaveCount(0);
  await expect(threadLink(page, "Plan my week")).toBeVisible();

  // Found in the Archive, narrowed to the hob, and it opens read-only.
  await chats.getByRole("link", { name: "Archived chats · 1" }).click();
  await expect(page).toHaveURL(new RegExp(`#/archive\\?hob=${pip.id}$`));
  const archived = page.getByRole("list", { name: "Archived chats" });
  await expect(archived.getByRole("listitem")).toHaveCount(1);
  await archived.getByRole("link", { name: "Read Rename the newsletter" }).click();
  const read = page.getByRole("main", { name: "Rename the newsletter" });
  await expect(read.getByRole("note")).toContainText("Pip takes no new messages here");
  await expect(read.getByText("Echo: Rename the newsletter", { exact: true })).toBeVisible();
  await expect(read.getByRole("textbox")).toHaveCount(0);
  const main = page.getByRole("main", { name: "Chat" });

  // Found by search too, marked archived, and it opens read-only from there.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await page.keyboard.press("ControlOrMeta+k");
  const finder = page.getByRole("dialog", { name: "Jump anywhere" });
  await finder.getByRole("combobox", { name: "Find a hob, thread or message" }).fill("newsletter");
  const result = finder.getByRole("option", { name: /Rename the newsletter/ });
  await expect(result).toContainText("Archived");
  await result.click();
  await expect(main.getByRole("region", { name: "Archived" })).toBeVisible();
  await expect(main.getByRole("textbox")).toHaveCount(0);

  // Restore: back in the hob's list with its history, and it takes messages again.
  await main.getByRole("button", { name: "Restore “Rename the newsletter”" }).click();
  await expect(threadLink(page, "Rename the newsletter")).toBeVisible();
  await expect(main.getByText("Echo: Rename the newsletter", { exact: true })).toBeVisible();
  const composer = main.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("Try a shorter name");
  await composer.press("Enter");
  await expect(main.getByText("Echo: Try a shorter name", { exact: true })).toBeVisible();
});
