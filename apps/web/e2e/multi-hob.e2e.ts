import type { Page } from "@playwright/test";
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

interface Hob {
  readonly id: string;
  readonly name: string;
  readonly configVersion: number;
}

interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly status: string;
  readonly configVersion: number | null;
}

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const summon = (current: Hub, name: string, model: string | null, effort: string | null, instructions: string) =>
  api<Hob>(current, "POST", "/agents", {
    name,
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: "pointed",
    tool: "none",
    lookSeed: name.length * 977,
    lookColor: "violet",
    runtime: "claude-code",
    model,
    effort,
    instructions,
  });

// The hub's fake runtime writes one word every 40 ms, so this reply streams for about ten seconds.
const longPrompt = (name: string) => `${name}: ${Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ")}`;

const send = async (page: Page, name: string, content: string) => {
  const composer = page.getByRole("textbox", { name: new RegExp(`^Message ${name}`) });
  await composer.fill(content);
  await composer.press("Enter");
};

const threadOf = (page: Page) => page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";

// covers AG-001, AG-002, AG-006
test("[TC-AG-098] three hobs with different models chat at once in the app, an edit mid-reply reaches only the next reply, and a retired hob stays readable", async ({
  context,
}) => {
  test.setTimeout(90_000);
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  // Three model choices the fake runtime takes: its main model, the one under "More models", and its default.
  const pip = await summon(current, "Pip", "fake-thinker", "high", "Write short answers.");
  const moss = await summon(current, "Moss", "fake-quick", null, "Tidy files.");
  const ash = await summon(current, "Ash", null, null, "Find bugs.");

  // One window per hob, each sending a long message, so all three replies run at the same time.
  const chats = [];
  for (const hob of [pip, moss, ash]) {
    const page = await context.newPage();
    await page.goto(`${current.url}/#/hobs/${hob.id}/new`);
    await send(page, hob.name, longPrompt(hob.name));
    chats.push({ hob, page });
  }
  for (const { hob, page } of chats) {
    await expect(page.getByText(new RegExp(`Echo: ${hob.name}: word0 word1`))).toBeVisible();
  }
  const [pipChat, mossChat, ashChat] = chats.map(({ hob, page }) => ({ hob, page, thread: threadOf(page) }));
  if (!pipChat || !mossChat || !ashChat) throw new Error("expected three chats");
  const all = [pipChat, mossChat, ashChat];
  const replies = async (threadId: string) =>
    (await api<ReadonlyArray<Message>>(current, "GET", `/threads/${threadId}/messages`)).filter(
      (m) => m.role === "assistant",
    );
  const statuses = await Promise.all(all.map(async (c) => (await replies(c.thread)).map((m) => m.status)));
  expect(statuses).toEqual([["streaming"], ["streaming"], ["streaming"]]);

  // Pip's instructions change in its profile, in another window, while its reply still runs.
  const profile = await context.newPage();
  await profile.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  const instructions = profile.getByRole("textbox", { name: "Instructions" });
  await expect(instructions).toHaveValue("Write short answers.");
  await instructions.fill("Write long answers.");
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(profile.getByText("Saved as version 2. Pip's next reply uses it.")).toBeVisible();
  expect((await replies(pipChat.thread)).map((m) => m.status)).toEqual(["streaming"]);

  // Every reply completes in its own window, on its own thread.
  for (const { hob, page } of all) {
    await expect(page.getByText(`Echo: ${longPrompt(hob.name)}`)).toBeVisible({ timeout: 20_000 });
  }
  await send(pipChat.page, "Pip", "second for Pip");
  await send(mossChat.page, "Moss", "second for Moss");
  await expect(pipChat.page.getByText("Echo: second for Pip")).toBeVisible();
  await expect(mossChat.page.getByText("Echo: second for Moss")).toBeVisible();

  // The reply running during the edit kept version 1; only Pip's next reply used version 2.
  const versions = () =>
    Promise.all(all.map(async (c) => (await replies(c.thread)).map((m) => [m.status, m.configVersion])));
  await expect.poll(versions).toEqual([
    [
      ["complete", 1],
      ["complete", 2],
    ],
    [
      ["complete", 1],
      ["complete", 1],
    ],
    [["complete", 1]],
  ]);
  // Pip's resumed session follows the edit, not the instructions it started with (#164).
  await send(pipChat.page, "Pip", "/instructions");
  await expect(pipChat.page.getByText("Write long answers.")).toBeVisible();
  await expect(pipChat.page.getByText("Write short answers.")).toHaveCount(0);
  for (const { hob, thread } of all) {
    const threadList = await api<ReadonlyArray<{ id: string }>>(current, "GET", `/agents/${hob.id}/threads`);
    expect(threadList.map((t) => t.id)).toEqual([thread]);
  }

  // Retiring Ash refuses new messages and keeps its chat readable from Archived hobs.
  await api(current, "POST", `/agents/${ash.id}/retire`, { activeWork: "finish" });
  const refused = await fetch(`${current.url}/api/threads/${ashChat.thread}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...current.headers },
    body: JSON.stringify({ content: "again" }),
  });
  expect(refused.status).toBe(409);
  await ashChat.page.goto(`${current.url}/#/settings/archived/${ash.id}/threads/${ashChat.thread}`);
  const archived = ashChat.page.getByRole("main", { name: "Chat" });
  await expect(archived.getByText(`Echo: ${longPrompt("Ash")}`)).toBeVisible();
  await expect(archived.getByRole("note")).toHaveText("Ash is retired, so this chat is read-only.");
  await expect(ashChat.page.getByRole("textbox")).toHaveCount(0);

  // Pip and Moss still chat after Ash retired.
  await send(mossChat.page, "Moss", "third for Moss");
  await expect(mossChat.page.getByText("Echo: third for Moss")).toBeVisible();
  const active = await api<ReadonlyArray<Hob>>(current, "GET", "/agents");
  expect(active.map((h) => [h.name, h.configVersion]).sort()).toEqual([
    ["Moss", 1],
    ["Pip", 2],
  ]);
});
