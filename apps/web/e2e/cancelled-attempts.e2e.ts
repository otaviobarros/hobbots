import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { lane, laneHead, laneMenu, laneTask, openRoom, taskSummary } from "./quest-room.ts";

// Issues #669 and #674 in the browser: a member's Task and a step cancelled while their turns run
// each end with a cancelled Attempt, and their Workbench says so. The decision is tested in
// packages/domain/test/turn-end.test.ts, and the hub's side in apps/server/test/turn-end.test.ts.

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

// covers EX-001, OR-006, UX-002
test("[TC-OR-459] a member's Task and a step cancelled mid-turn say in their lane that the attempt stopped", async ({
  page,
}) => {
  test.setTimeout(120_000);
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

  // Frodo runs a long job as a step of his Task and brings in Pip for another; both keep running.
  const LONG = "fake:tool Bash sleep 600";
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Build the project",
      hubCall("plan_steps", { key: "plan", steps: [{ brief: ["Run the long job", LONG].join("\n") }] }),
      hubCall("delegate_task", { key: "check", hob: "Pip", brief: ["Check the build", LONG].join("\n") }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await openRoom(page, "Build the project");

  for (const [name, title] of [
    ["Frodo", "Run the long job"],
    ["Pip", "Check the build"],
  ] as const) {
    // You cancel it from its hob's lane while its turn runs: Frodo's step stays in his lane, so
    // his menu cancels it on its own, apart from his Quest.
    const sheet = laneTask(page, title);
    await expect(name === "Pip" ? laneHead(page, name) : sheet).toContainText("Running", { timeout: 30_000 });
    const menu = await laneMenu(page, name);
    await menu.getByRole("menuitem", { name: name === "Frodo" ? "Cancel a step…" : "Cancel task…" }).click();
    const its = lane(page, name);
    await its.getByRole("button", { name: "Yes, cancel" }).click();
    await expect(its.getByRole("status").filter({ hasText: "Cancelled: the task confirmed it stopped." })).toBeVisible({
      timeout: 30_000,
    });

    // Its summary in the lane says the attempt stopped, and why, never that it finished.
    const summary = await taskSummary(page, title);
    await expect(summary).toContainText("This attempt stopped before it finished.");
    await expect(summary).toContainText("Why: You cancelled this Task.");
  }
});
