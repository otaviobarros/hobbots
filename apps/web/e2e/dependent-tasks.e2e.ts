import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #564 in the browser: a Task delegated with depends_on waits, and shows whom it waits on in
// the Quest tab, until the Task it depends on is done; only then does it run. The hub-level checks
// are in apps/server/test/dependent-tasks-wait.test.ts.

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

// covers OR-002, OR-003, UX-002
test("[TC-OR-204] the Quest tab shows Rook's Task waiting on Quill while Quill's runs, and Rook's runs only once Quill's is done", async ({
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

  // Aldric brings in Quill, whose push waits for you, and Rook, whose Task depends on Quill's.
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
          "fake:tool Bash git push origin feature",
          script("complete_task", { key: "backend-done", summary: "Backend ready." }),
        ].join("\n"),
      }),
      script("delegate_task", {
        key: "frontend",
        hob: "Rook",
        brief: [
          "Write the frontend",
          script("complete_task", { key: "frontend-done", summary: "Frontend ready." }),
        ].join("\n"),
        depends_on: ["$backend.task_id"],
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));
  const thread = page.url();
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });

  // While Quill's Task waits on your push, Rook's waits on Quill's and has not run.
  await page.getByRole("tab", { name: "Quest" }).click();
  const tasks = page.getByRole("list", { name: "Tasks of Build the app" });
  const frontend = tasks.getByRole("button", { name: /Rook · Write the frontend/ });
  await expect(frontend).toContainText("waiting on Quill");
  await expect(frontend).toContainText("Waiting");
  await expect(frontend).not.toContainText("Running");

  // You allow the push: Quill's Task completes, and only then does Rook's run, to Done.
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const request = page.getByRole("article", { name: "Request from Quill: Push your work" });
  await request.getByRole("button", { name: "Allow once" }).click();
  await expect(request.getByRole("status")).toHaveText("✓ Allowed once. Quill carries on.");
  await page.goto(thread);
  await page.getByRole("tab", { name: "Quest" }).click();
  await expect(tasks.getByRole("button", { name: /Quill · Write the backend/ })).toContainText("Done", {
    timeout: 20_000,
  });
  await expect(frontend).toContainText("Done", { timeout: 20_000 });
  await expect(frontend).not.toContainText("waiting on Quill");
});
