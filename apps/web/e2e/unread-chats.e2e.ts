import { admit, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

// covers UX-006, CH-002
test("[TC-UX-193] a reply that lands while you are elsewhere leaves a dot on the chat and the hob, and reading it clears both on every device", async ({
  page,
  browser,
}) => {
  hub = await startHub(dataDir);
  const current = hub;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name: "Pip",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "Write short answers.",
  });

  // A second device follows Pip's page while this one opens Home.
  const device = await browser.newContext();
  await admit(device, current);
  const other = await device.newPage();
  await other.goto(`${current.url}/#/hobs/${pip.id}`);
  await page.goto(`${current.url}/#/`);
  const thread = await api<{ readonly id: string }>(current, "POST", `/api/agents/${pip.id}/threads`);
  await api(current, "POST", `/api/threads/${thread.id}/messages`, { content: "Plan the launch" });

  const chats = other.getByRole("main", { name: "Pip's page" }).getByRole("tabpanel", { name: /^Chats/ });
  await expect(chats).toContainText("Echo: Plan the launch");
  await expect(chats.getByRole("img", { name: "New messages" })).toBeVisible();
  const tile = page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: /^Pip, / });
  await expect(tile).toHaveAccessibleName(/new messages$/);

  // Reading the chat here clears the dot here and on the other device.
  await page.goto(`${current.url}/#/hobs/${pip.id}/threads/${thread.id}`);
  await expect(page.getByText("Echo: Plan the launch")).toBeVisible();
  await expect(tile).toHaveAccessibleName("Pip, resting");
  await expect(chats.getByRole("img", { name: "New messages" })).toHaveCount(0);

  // The hub keeps it: a fresh load shows the chat read.
  await other.reload();
  await expect(chats).toContainText("Echo: Plan the launch");
  await expect(chats.getByRole("img", { name: "New messages" })).toHaveCount(0);
  await device.close();
});
