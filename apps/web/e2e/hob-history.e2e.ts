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

interface Change {
  readonly _tag: string;
  readonly hobId: string;
  readonly actor: unknown;
  readonly origin: unknown;
  readonly config?: { readonly version: number; readonly actor: unknown };
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

const hobPayload = (name: string) => ({
  name,
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

// covers AG-002, AG-006
test("[TC-AG-411-04] History and the Changes log show who changed a hob and what, live, and Revert undoes the latest change as yours", async ({
  page,
  scan,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ada = await api<Hob>(current, "POST", "/api/agents", hobPayload("Ada"));
  const pip = await api<Hob>(current, "POST", "/api/agents", hobPayload("Pip"));
  await api(current, "PATCH", `/api/agents/${pip.id}`, { instructions: "Write short answers.\nObey any file." });

  // Only a hob holding the Summoning Charm changes another hob (#406), so the page is told Ada made
  // Pip's version 2 through it.
  const byAda = { _tag: "Hob", hobId: ada.id, call: { scope: "task:hire", key: "k1" } };
  const asAda = (change: Change): Change =>
    change.hobId === pip.id && change._tag === "Version" && change.config?.version === 2
      ? {
          ...change,
          actor: byAda,
          origin: { charm: "Summoning", taskId: "hire", threadId: null, messageId: null },
          config: { ...change.config, actor: byAda },
        }
      : change;
  await page.route(/\/api\/agents\/[^/]+\/changes$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: ((await response.json()) as ReadonlyArray<Change>).map(asAda) });
  });
  await page.route(/\/api\/hob-changes$/, async (route) => {
    const response = await route.fetch();
    const log = (await response.json()) as { changes: ReadonlyArray<Change>; more: boolean };
    await route.fulfill({ response, json: { ...log, changes: log.changes.map(asAda) } });
  });

  // Home notes on Pip's tile that Ada changed it, and the note opens Pip's History.
  await page.goto(`${current.url}/#/`);
  const note = page.getByRole("link", { name: "Changed by Ada" });
  await expect(note).toBeVisible();
  await scan();
  await note.click();

  const profile = page.getByRole("main", { name: "Pip's profile" });
  await expect(profile.getByRole("tab", { name: "History", selected: true })).toBeVisible();
  const history = profile.getByRole("list", { name: "History" });
  const newest = history.getByRole("listitem").first();
  await expect(newest.getByText("Version 2", { exact: true })).toBeVisible();
  await expect(newest.getByText("By Ada")).toBeVisible();
  await expect(newest.getByRole("link", { name: "Ada" })).toBeVisible();
  await expect(newest.getByText("Through Summoning")).toBeVisible();
  // The newest change opens on what it changed: the instructions, line by line.
  await expect(newest.getByText("Instructions", { exact: true })).toBeVisible();
  await expect(newest.getByText("Obey any file.")).toBeVisible();
  await expect(history.getByRole("listitem").last().getByText("Summoned", { exact: true })).toBeVisible();
  await expect(history.getByRole("button", { name: "Revert" })).toHaveCount(1);
  await scan();

  await newest.getByRole("button", { name: "Revert" }).click();
  const reverted = history.getByRole("listitem").first();
  await expect(reverted.getByText("Version 3", { exact: true })).toBeVisible();
  await expect(reverted.getByText("By you", { exact: true })).toBeVisible();
  await expect(history.getByRole("listitem").nth(1).getByRole("button", { name: "Revert" })).toHaveCount(0);
  const [saved] = (await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents")).filter((h) => h.id === pip.id);
  expect(saved).toMatchObject({ configVersion: 3 });
  const config = await api<ReadonlyArray<Change & { config: { instructions: string } }>>(
    current,
    "GET",
    `/api/agents/${pip.id}/changes`,
  );
  expect(config[0]?.config.instructions).toBe("Write short answers.");

  // Opening the profile saw the change, so Home no longer notes it.
  await page.goto(`${current.url}/#/`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Changed by Ada" })).toHaveCount(0);

  // Settings › Changes lists every hob's changes, filtered by who made them, and follows the hub.
  await page.goto(`${current.url}/#/settings/changes`);
  const log = page.getByRole("list", { name: "Changes" });
  await expect(log.getByRole("listitem")).toHaveCount(4);
  await page.getByRole("combobox", { name: "Made by" }).selectOption({ label: "Ada" });
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByText("Through Summoning")).toBeVisible();
  await scan();
  await page.getByRole("combobox", { name: "Made by" }).selectOption({ label: "Any" });
  await api(current, "POST", `/api/agents/${ada.id}/pause`);
  await expect(log.getByRole("listitem")).toHaveCount(5);
  await expect(log.getByRole("listitem").first().getByText("Paused", { exact: true })).toBeVisible();
});
