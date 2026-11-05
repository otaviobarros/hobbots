import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { lane, laneHead, openRoom } from "./quest-room.ts";

// Issue #572 in the browser: a lead that waits on a member's Task shows Running in the quest sheet
// while its turn still runs, and Waiting once the turn has ended. The hub's side is tested in
// apps/server/test/wait-ends-turn.test.ts.

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

/**
 * A long command keeps Quill's turn, and so her Task, open for the whole test without asking you
 * anything: a request waiting on you would show the lead as Needs you instead (#698).
 */
const LONG_JOB = "fake:tool Bash sleep 600";

/**
 * The fake writes its reply a word at a time once its hub calls are made, so a long reply keeps the
 * turn running for a while after it waits.
 */
const LONG_REPLY = Array.from({ length: 250 }, (_, index) => `word${index}`).join(" ");

// covers OR-003, UX-001
test("[TC-OR-242] the quest sheet shows the lead Running while the turn that waits still runs, and Waiting after it", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await request(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const frodo = await summon(current, "Frodo", 4100);
  await summon(current, "Quill", 4821);

  // Frodo brings in Quill, waits for her, checks the wait again, and goes on writing his reply.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Ship the backend",
      hubCall("delegate_task", { key: "backend", hob: "Quill", brief: ["Write the backend", LONG_JOB].join("\n") }),
      hubCall("wait_for", { key: "wait", tasks: ["$backend.task_id"] }),
      hubCall("wait_for", { key: "wait-again", tasks: ["$backend.task_id"] }),
      LONG_REPLY,
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  const stop = page.getByRole("button", { name: /Stop/ });
  await expect(stop).toBeVisible();

  // Both waits are made while his turn still runs: his Task shows Running, not Waiting.
  await expect(page.getByRole("list", { name: "Reply steps" }).getByText("Waiting on Tasks")).toHaveCount(2);
  await openRoom(page, "Ship the backend");
  const lead = laneHead(page, "Frodo");
  await expect(lead).toContainText("Running");
  await expect(stop).toBeVisible();
  await expect(lane(page, "Frodo")).not.toContainText("Waits on");

  // His turn ends, and only now his Task waits, on Quill's one Task.
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(lead).toContainText("Lead");
  await expect(lead).toContainText("Waiting");
  await expect(lane(page, "Frodo")).toContainText("Waits on Quill");
  await expect(lead).not.toContainText("Running");
});
