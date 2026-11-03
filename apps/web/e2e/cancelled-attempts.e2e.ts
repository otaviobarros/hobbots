import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

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
test("[TC-OR-459] a member's Task and a step cancelled mid-turn say in the Workbench that the attempt stopped", async ({
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
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Build the project" });

  for (const [row, title] of [
    [/^Frodo · Run the long job/, "Run the long job"],
    [/^Pip · Check the build/, "Check the build"],
  ] as const) {
    // You cancel it from the Quest tab while its turn runs.
    const task = room.getByRole("button", { name: row });
    await expect(task).toContainText("Running", { timeout: 30_000 });
    await task.click();
    const controls = room.getByRole("region", { name: `Controls for ${title}` });
    await controls.getByRole("button", { name: "Cancel Task" }).click();
    await controls.getByRole("button", { name: "Yes, cancel" }).click();
    await expect(controls.getByRole("status")).toHaveText("Cancelled: the Task confirmed it stopped.", {
      timeout: 30_000,
    });

    // Its Workbench says the attempt stopped, and why, never that it finished.
    await controls.getByRole("button", { name: "Open in Workbench" }).click();
    const bench = page.getByRole("region", { name: `Workbench for ${title}` });
    const summary = bench.getByRole("tabpanel", { name: /^Summary/ });
    await expect(summary).toContainText("This attempt stopped before it finished.");
    await expect(summary).toContainText("Why: You cancelled this Task.");
    await bench.getByRole("button", { name: "← Back to chat" }).click();
    await page.getByRole("tab", { name: "Quest" }).click();
  }
});
