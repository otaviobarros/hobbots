import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { openQuest } from "./work-sheet.ts";

// Issue #566 in the browser: Rook, running alongside Quill, asks Aldric for Quill's core.py. Aldric,
// on Quill's result, hands it off and answers, and Rook's Task finishes with core.py under Handed to
// it, beside Quill's result. That the lead's turn states the rule is checked in
// apps/server/test/lead-hand-off.test.ts.

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

// covers OR-003, OR-005
test("[TC-OR-219] Aldric hands Quill's core.py to Rook, who asked for it while running, and Rook's Task finishes with it", async ({
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
  // Aldric delegates Rook's Task only on Quill's result, so core.py exists when Rook asks; on the
  // question, Aldric's next turn hands it off and answers.
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
      `fake:then ${script("delegate_task", {
        key: "frontend",
        hob: "Rook",
        brief: [
          "Write the frontend",
          script("ask", { key: "need", question: "Will you hand me Quill's core.py?" }),
          `fake:then ${script("complete_task", { key: "frontend-done", summary: "Frontend reads core.py." })}`,
        ].join("\n"),
      })}`,
      `fake:then fake:then ${script("hand_off", { key: "hand", artifact_id: "$backend-done.artifacts.0", to_task_id: "$frontend.task_id" })}`,
      `fake:then fake:then ${script("answer", { key: "reply", question_id: "$need.question_id", answer: "Handed core.py to your Task." })}`,
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));

  const tasks = await openQuest(page, "Build the app");
  const frontend = tasks.getByRole("button", { name: /Rook · Write the frontend/ });
  await expect(frontend).toContainText("Done", { timeout: 30_000 });
  await frontend.click();
  const drawer = page.getByRole("dialog", { name: "Write the frontend, task details" });
  await expect(drawer).toBeVisible();
  await drawer.getByText("Everything in this task").click();
  await expect(drawer.getByRole("heading", { name: "Handed to it" })).toBeVisible();
  await expect(drawer).toContainText("core.py");
  await expect(drawer).toContainText("/project/core.py");
  // Quill's Task handed core.py to Rook's, so its result is listed too, and only once.
  await expect(drawer.getByText(/Quill's result/)).toHaveCount(1);
});
