import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

// Folders a test made for a hob to work in.
const extraDirs: Array<string> = [];

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  for (const dir of extraDirs.splice(0)) removeDataDir(dir);
});

interface Hob {
  readonly id: string;
  readonly instructions: string;
  readonly configVersion: number;
}

interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly configVersion: number | null;
}

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A hub past onboarding with one hob, Pip, made through the API as Summon makes it. */
const hubWithPip = async (env: Record<string, string> = {}): Promise<{ current: Hub; pip: Hob }> => {
  const current = await startHub(dataDir, env);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<Hob>(current, "POST", "/api/agents", {
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
    instructions: "Write short answers.",
  });
  return { current, pip };
};

// Pip's page lists its chats; these tests have one.
const openOnlyChat = (page: Page) =>
  page
    .getByRole("main", { name: "Pip's page" })
    .getByRole("link", { name: /^Open / })
    .click();

const send = async (page: Page, content: string) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(content);
  await composer.press("Enter");
  await expect(page.getByRole("main").getByText(`Echo: ${content}`)).toBeVisible();
};

// Edit hob sits in the chat header's ⋯ menu.
const editHob = async (page: Page) => {
  await page.getByRole("main", { name: "Chat" }).getByRole("button", { name: "More for this chat" }).click();
  await page.getByRole("menuitem", { name: "Edit hob" }).click();
};

test("editing instructions in the profile changes the next reply", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/chat`);
  await send(page, "first");

  await editHob(page);
  await expect(page.getByRole("heading", { name: "Pip", exact: true })).toBeVisible();
  const instructions = page.getByRole("textbox", { name: "What Pip should do" });
  await expect(instructions).toHaveValue("Write short answers.");
  await instructions.fill("Write long answers.");
  await expect(page.getByText("1 change not saved yet")).toBeVisible();
  // Looking at another tab keeps the unsaved edit. The arrow keys move between the tabs.
  await page.getByRole("tab", { name: "Charms" }).click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
  await expect(instructions).toHaveValue("Write long answers.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Pip gets this from its next turn/)).toBeVisible();
  await expect(page.getByText(/· Version 2$/)).toBeVisible();

  // Back in the chat, the same thread's next reply runs on the edited configuration.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await openOnlyChat(page);
  await expect(page.getByRole("main").getByText("Echo: first")).toBeVisible();
  await send(page, "second");

  const [saved] = await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({ instructions: "Write long answers.", configVersion: 2 });
  const [thread] = await api<ReadonlyArray<{ id: string }>>(current, "GET", `/api/agents/${pip.id}/threads`);
  // The page shows the reply while it streams; it is stored once it completes.
  await expect
    .poll(async () => {
      const messages = await api<ReadonlyArray<Message>>(current, "GET", `/api/threads/${thread?.id}/messages`);
      return messages.filter((m) => m.role === "assistant").map((m) => [m.content, m.configVersion]);
    })
    .toEqual([
      ["Echo: first", 1],
      ["Echo: second", 2],
    ]);
});

test("renaming a hob and changing its look in the profile shows them everywhere, past chats too", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/chat`);
  await send(page, "first");

  await editHob(page);
  const profile = page.getByRole("main", { name: "Pip's profile" });
  const look = profile.getByRole("region", { name: "Name and look" });
  await look.getByRole("button", { name: "Change name or look" }).click();
  const name = look.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue("Pip");
  await name.fill("  ");
  await expect(profile.getByText("Give the hob a name.")).toBeVisible();
  await expect(profile.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await name.fill("Bramble");
  await expect(look.getByRole("radio", { name: "Look 1" })).toBeChecked();
  await look.getByRole("radio", { name: "Look 3" }).check({ force: true });
  await look.getByRole("radio", { name: "Sky" }).check({ force: true });
  await look.getByRole("radio", { name: "Tiny crown" }).click();
  await look.getByRole("radio", { name: "From the look" }).last().click();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Bramble gets this from its next turn/)).toBeVisible();

  const renamed = page.getByRole("main", { name: "Bramble's profile" });
  await expect(renamed.getByRole("heading", { name: "Bramble", exact: true })).toBeVisible();
  const [saved] = await api<ReadonlyArray<Hob & { name: string; lookSeed: number }>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({ name: "Bramble", lookColor: "sky", hat: "crown", tool: null, configVersion: 2 });
  expect(saved?.lookSeed).not.toBe(4821);

  // The chat it had before the rename says its new name.
  await page.goto(`${current.url}/#/hobs/${pip.id}`);
  await page
    .getByRole("main", { name: "Bramble's page" })
    .getByRole("link", { name: /^Open / })
    .click();
  await expect(page.getByRole("main").getByText("Echo: first")).toBeVisible();
  await expect(page.getByRole("main", { name: "Chat" }).getByText("Bramble", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("main", { name: "Chat" }).getByText("Pip", { exact: true })).toHaveCount(0);
});
