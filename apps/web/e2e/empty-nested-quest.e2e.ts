import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { openQuest } from "./work-sheet.ts";

// Issue #576 in the browser: a member that started a Quest of its own and brought nobody in shows
// "No one brought in yet" under its row on the quest sheet. The hub's side is tested in
// apps/server/test/empty-nested-quest.test.ts.

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

const request = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const summon = (current: Hub, name: string, lookSeed: number) =>
  request<{ readonly id: string }>(current, "POST", "/api/agents", {
    name,
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed,
    lookColor: "sky",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

/** A prompt line that makes the fake call a Task tool. */
const hubCall = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// covers OR-004, UX-001
test("[TC-OR-247] the quest sheet says a member's own Quest has no one brought in yet", async ({ page }) => {
  const current = await startHub(dataDir);
  hub = current;
  await request(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const frodo = await summon(current, "Frodo", 4100);
  await summon(current, "Pip", 4821);

  // Pip starts a Quest of his own, asks Frodo something, and ends his turn with nobody brought in.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Review the project",
      hubCall("delegate_task", {
        key: "review",
        hob: "Pip",
        brief: [
          "Review the work",
          hubCall("start_quest", { key: "nested", goal: "Review and commit the project" }),
          hubCall("ask", { key: "who", question: "Should Nettle make the commit?" }),
        ].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();

  const tasks = await openQuest(page, "Review the project");
  const pip = tasks.getByRole("button", { name: /^Pip · Review the work/ });
  await expect(pip).toContainText("Leads a quest", { timeout: 20_000 });
  await expect(pip).toContainText("No one brought in yet");
  // Frodo's own row leads Pip, so it never says so.
  await expect(tasks.getByRole("button", { name: /^Frodo · Review the project/ })).not.toContainText(
    "No one brought in yet",
  );
});
