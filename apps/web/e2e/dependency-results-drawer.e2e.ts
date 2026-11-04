import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { laneHead, openRoom, taskDetails } from "./quest-room.ts";

// Issue #567 in the browser: once the Task Rook's comes after has completed, Rook's Task drawer
// shows what it returned under Handed to it: Quill's result and the file he made. The prompt side
// is checked in apps/server/test/dependency-status.test.ts.

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

// covers OR-003, UX-002
test("[TC-OR-215] Rook's Task drawer shows Quill's result and core.py under Handed to it once Quill's Task is done", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Quill", 4821);
  await hobNamed(current, "Rook", 5732);

  await page.goto(`${current.url}/#/hobs/${aldric.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Build the app",
      script("delegate_task", {
        key: "backend",
        hob: "Quill",
        brief: [
          "Write the backend",
          script("complete_task", {
            key: "backend-done",
            summary: "Stores amounts as integer cents.",
            artifacts: [{ kind: "file", label: "core.py", value: "/project/core.py" }],
          }),
        ].join("\n"),
      }),
      script("delegate_task", {
        key: "frontend",
        hob: "Rook",
        brief: "Write the frontend",
        depends_on: ["$backend.task_id"],
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));

  await openRoom(page, "Build the app");
  await expect(laneHead(page, "Rook")).toContainText("Done", { timeout: 30_000 });
  const drawer = await taskDetails(page, "Write the frontend");
  await expect(drawer.getByRole("heading", { name: "Handed to it" })).toBeVisible();
  await expect(drawer).toContainText("Quill's result: Stores amounts as integer cents.");
  await expect(drawer).toContainText("core.py");
  await expect(drawer).toContainText("/project/core.py");
});
