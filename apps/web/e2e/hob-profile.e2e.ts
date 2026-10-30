import { expect, type Page, test } from "@playwright/test";
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
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A hub past onboarding with one hob, Pip, made through the API as Summon makes it. */
const hubWithPip = async (): Promise<{ current: Hub; pip: Hob }> => {
  const current = await startHub(dataDir);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<Hob>(current, "POST", "/api/agents", {
    name: "Pip",
    craft: "Scribe",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "Write short answers.",
  });
  return { current, pip };
};

const send = async (page: Page, content: string) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(content);
  await composer.press("Enter");
  await expect(page.getByText(`Echo: ${content}`)).toBeVisible();
};

// covers AG-002
test("[TC-AG-070] editing instructions in the profile changes the next reply", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
  await send(page, "first");

  await page.getByRole("link", { name: "Edit hob" }).click();
  await expect(page.getByRole("heading", { name: "Pip the Scribe" })).toBeVisible();
  const instructions = page.getByRole("textbox", { name: "Instructions" });
  await expect(instructions).toHaveValue("Write short answers.");
  await instructions.fill("Write long answers.");
  await expect(page.getByText(/^Unsaved changes/)).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved as version 2. Pip's next reply uses it.")).toBeVisible();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();

  // Back in the chat, the same thread's next reply runs on the edited configuration.
  await page.getByRole("link", { name: "← Back to chat" }).click();
  await expect(page.getByText("Echo: first")).toBeVisible();
  await send(page, "second");

  const [saved] = await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({ instructions: "Write long answers.", configVersion: 2 });
  const [thread] = await api<ReadonlyArray<{ id: string }>>(current, "GET", `/api/agents/${pip.id}/threads`);
  const messages = await api<ReadonlyArray<Message>>(current, "GET", `/api/threads/${thread?.id}/messages`);
  expect(messages.filter((m) => m.role === "assistant").map((m) => [m.content, m.configVersion])).toEqual([
    ["Echo: first", 1],
    ["Echo: second", 2],
  ]);
});

// covers AG-006
test("[TC-AG-071] pausing, waking and retiring from the profile moves the hob to Archived hobs", async ({ page }) => {
  const { current, pip } = await hubWithPip();
  hub = current;
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await expect(page.getByRole("heading", { name: "Pip the Scribe" })).toBeVisible();

  await page.getByRole("button", { name: "Pause Pip" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: /^Paused$/ })).toBeVisible();
  await page.getByRole("button", { name: "Wake Pip" }).click();
  await expect(page.getByRole("button", { name: "Pause Pip" })).toBeVisible();

  // Keeping Pip changes nothing.
  await page.getByRole("button", { name: "Retire hob" }).click();
  const dialog = page.getByRole("dialog", { name: "Retire Pip?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep Pip" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Retire hob" }).click();
  await dialog.getByText("Stop Pip's work now").click();
  await expect(dialog.getByRole("radio", { name: /Stop Pip's work now/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Retire Pip" }).click();
  await expect(page.getByRole("dialog", { name: "Pip is retired" })).toBeVisible();

  expect(await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents")).toEqual([]);
  expect(await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents?status=retired")).toMatchObject([
    { id: pip.id, status: "retired" },
  ]);
  await page.getByRole("link", { name: "See archived hobs" }).click();
  await expect(page).toHaveURL(/#\/settings\/archived$/);
});
