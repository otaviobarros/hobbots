import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { laneHead, openRoom, roomMenu } from "./quest-room.ts";

// Issue #565 in the browser: a chain of dependent Tasks runs to the end from one message. Each
// Task starts once the ones it comes after are done, with what they returned, so nobody has to hand
// anything on or nudge the lead. The hub-level checks are in apps/server/test/dependency-wakes.test.ts.

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

// covers OR-002, OR-003, OR-007
test("[TC-OR-209] a three-member Quest with a dependency chain runs to finished from one message, with no action of yours", async ({
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
  await hobNamed(current, "Pip", 6643);

  // Quill writes the backend, Rook the frontend after it, and Pip reviews both. Aldric wraps up on
  // the continuation that brings the last result; until then wrapping up is refused.
  const wrap = (key: string) => script("complete_task", { key, summary: "The app is built and reviewed." });
  await page.goto(`${current.url}/#/hobs/${aldric.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Build and review the app",
      script("delegate_task", {
        key: "backend",
        hob: "Quill",
        brief: ["Write the backend", script("complete_task", { key: "backend-done", summary: "Backend ready." })].join(
          "\n",
        ),
      }),
      script("delegate_task", {
        key: "frontend",
        hob: "Rook",
        brief: "Write the frontend",
        depends_on: ["$backend.task_id"],
      }),
      script("delegate_task", {
        key: "review",
        hob: "Pip",
        brief: "Review the backend and the frontend",
        depends_on: ["$backend.task_id", "$frontend.task_id"],
      }),
      script("wait_for", { key: "wait", tasks: ["$backend.task_id", "$frontend.task_id", "$review.task_id"] }),
      `fake:then ${wrap("wrap-1")}`,
      `fake:then fake:then ${wrap("wrap-2")}`,
      `fake:then fake:then fake:then ${wrap("wrap-3")}`,
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));

  // The room follows every Task to Done, and the Quest ends: no Cancel quest is left.
  await openRoom(page, "Build and review the app");
  for (const name of ["Quill", "Rook", "Pip"]) {
    await expect(laneHead(page, name)).toContainText("Done", { timeout: 30_000 });
  }
  await roomMenu(page, "Build and review the app");
  await expect(page.getByRole("menuitem", { name: "Cancel quest…" })).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByText("The app is built and reviewed.").first()).toBeVisible();
});
