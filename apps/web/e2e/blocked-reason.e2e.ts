import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #571 in the browser: Rook's Task is blocked only when its own milestone is all that keeps
// it open, and its Quest tab row then says why, in the words its lead reads. The hub side is
// checked in apps/server/test/blocked-reason.test.ts.

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
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

const hobNamed = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name,
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// covers OR-004, UX-002
test("[TC-OR-223] the Task card and drawer say why Rook's Task is blocked, not a bare Blocked", async ({ page }) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Rook", 5732);

  await page.goto(`${current.url}/#/hobs/${aldric.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Build the app",
      script("delegate_task", { key: "frontend", hob: "Rook", brief: "Write the frontend", milestones: ["Page live"] }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));

  await page.getByRole("tab", { name: "Quest" }).click();
  const tasks = page.getByRole("list", { name: "Tasks of Build the app" });
  const frontend = tasks.getByRole("button", { name: /Rook · Write the frontend/ });
  await expect(frontend).toContainText("Blocked", { timeout: 30_000 });
  // The Task card in the chat gives the reason on Rook's row.
  const cardRow = page.getByRole("button", { name: "Look inside Write the frontend" });
  await expect(cardRow).toContainText("Its member ended a turn without completing it");
  await expect(cardRow).toContainText("Blocked");
  await frontend.click();
  const drawer = page.getByRole("dialog", { name: "Write the frontend, Task details" });
  await expect(drawer).toContainText('only its own milestones are unreported: "Page live"');
  await expect(drawer).toContainText("It waits on no question, approval or other Task");
});
