import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { lane, laneHead, openQuest } from "./quest-sheet.ts";

// Issue #408 in the browser: Retire lists a hob's open work, hands its open Tasks to another hob,
// or lets it finish them first. The hub-level checks are in apps/server/test/task-controls.test.ts.

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

interface Hob {
  readonly id: string;
  readonly status: string;
  readonly retiring: unknown;
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

const hobNamed = (current: Hub, name: string, lookSeed: number) =>
  api<Hob>(current, "POST", "/api/agents", {
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

// covers AG-006, OR-006
test("[TC-AG-1248] Retire lists a hob's open work, hands its Task to another hob, and lets another finish first", async ({
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
  const quill = await hobNamed(current, "Quill", 4821);
  const rook = await hobNamed(current, "Rook", 5732);
  await hobNamed(current, "Pip", 6643);

  // Aldric brings in Quill, whose push waits for you, and Rook, whose Task waits on Quill's.
  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
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
          script("complete_task", { delivered: true, key: "backend-done", summary: "Backend ready." }),
        ].join("\n"),
      }),
      script("delegate_task", {
        key: "frontend",
        hob: "Rook",
        brief: [
          "Write the frontend",
          script("complete_task", { delivered: true, key: "frontend-done", summary: "Frontend ready." }),
        ].join("\n"),
        depends_on: ["$backend.task_id"],
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));
  const thread = page.url();
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });

  // Rook hands its waiting Task to Pip. Aldric leads the work above it, so he cannot take it.
  await page.goto(`${current.url}/#/hobs/${rook.id}/profile`);
  const rookRest = page.getByRole("main", { name: "Rook's profile" }).getByRole("region", { name: "Take a break" });
  await rookRest.getByRole("button", { name: "Retire Rook…" }).click();
  const retireRook = page.getByRole("dialog", { name: "Retire Rook?" });
  await expect(retireRook).toContainText("Rook still has work open.");
  await expect(retireRook).toContainText("1 open Task");
  await expect(retireRook).toContainText("Write the frontend");
  await retireRook.getByText("Stop Rook and hand its Tasks over").click();
  const confirmRook = retireRook.getByRole("button", { name: "Retire Rook", exact: true });
  await expect(confirmRook).toBeDisabled();
  await retireRook.getByLabel("Hand them to").selectOption({ label: "Aldric" });
  await expect(retireRook).toContainText("Aldric already works on the Task above this one.");
  await expect(confirmRook).toBeDisabled();
  await retireRook.getByLabel("Hand them to").selectOption({ label: "Pip" });
  await expect(retireRook).not.toContainText("Aldric already works");
  await confirmRook.click();
  await expect(page.getByRole("dialog", { name: "Rook is asleep" })).toContainText("Rook's open Tasks went to Pip.");
  await page.getByRole("button", { name: "Go to Home" }).click();

  // Quill finishes first: its Task and its waiting push are listed, and it stays until the Task ends.
  await page.goto(`${current.url}/#/hobs/${quill.id}/profile`);
  const quillRest = page.getByRole("main", { name: "Quill's profile" }).getByRole("region", { name: "Take a break" });
  await quillRest.getByRole("button", { name: "Retire Quill…" }).click();
  const retireQuill = page.getByRole("dialog", { name: "Retire Quill?" });
  await expect(retireQuill).toContainText("Write the backend");
  await expect(retireQuill).toContainText("1 approval waits");
  await expect(retireQuill.getByRole("radio", { name: /Let Quill finish its Tasks first/ })).toBeChecked();
  await retireQuill.getByRole("button", { name: "Retire Quill", exact: true }).click();
  const waiting = page.getByRole("dialog", { name: "Quill retires when done" });
  await expect(waiting).toContainText("Quill finishes its open Tasks, then retires.");
  await waiting.getByRole("button", { name: "Close" }).click();
  await expect(quillRest).toContainText("Quill is finishing its open Tasks, then retires.");
  expect(await api<Hob>(current, "GET", `/api/agents/${quill.id}/open-work`)).toMatchObject({
    approvals: [{ label: expect.stringMatching(/push/i) }],
  });

  // You allow the push: Quill's Task completes, Pip's runs to Done, and Quill retires.
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const request = page.getByRole("article", { name: "Request from Quill: Push your work" });
  await request.getByRole("button", { name: "Allow once" }).click();
  await expect(request.getByRole("status")).toHaveText("✓ Allowed once. Quill carries on.");
  await page.goto(thread);
  await openQuest(page, "Build the app");
  // Pip's Task waited on Quill's, so Quill's completed first.
  await expect(laneHead(page, "Pip")).toContainText("Done", { timeout: 20_000 });
  await expect(lane(page, "Pip")).not.toContainText("Waits on Quill");
  await expect
    .poll(async () => (await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents?status=retired")).map((h) => h.id))
    .toEqual(expect.arrayContaining([quill.id, rook.id]));
});
