import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { laneHead, openQuest, taskSummary } from "./quest-sheet.ts";

// Issue #743 in the browser: a member's milestone is reached by its lead's work, such as a commit
// the member could not make. The member reports it naming the lead, and its Task shows the lead
// reached it. The hub's side is tested in apps/server/test/task-tools.test.ts.

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

// covers OR-002, UX-002
test("[TC-OR-655] a member's milestone reached through its lead's work shows on its Task as reached by the lead", async ({
  page,
  scan,
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
  await summon(current, "Nettle", 4821);

  // Nettle builds the page; Frodo made the commit, so Nettle reports "Committed" as reached by Frodo.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Ship the page",
      hubCall("delegate_task", {
        key: "build",
        hob: "Nettle",
        milestones: ["Built", "Committed"],
        brief: [
          "Build the page",
          hubCall("report_checkpoint", {
            key: "built",
            kind: "milestone",
            summary: "Built",
            milestone_id: "$build.milestones.0",
          }),
          hubCall("report_checkpoint", {
            key: "committed",
            kind: "milestone",
            summary: "Committed",
            milestone_id: "$build.milestones.1",
            reached_by: "Frodo",
          }),
          hubCall("complete_task", { delivered: true, key: "done", summary: "Built the page; Frodo made the commit" }),
        ].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$build.task_id"] }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await scan();
  await composer.press("Enter");

  await openQuest(page, "Ship the page");
  await expect(laneHead(page, "Nettle")).toContainText("Done", { timeout: 45_000 });

  // Its own milestone says nothing more; the one Frodo's work reached names him.
  const happened = (await taskSummary(page, "Build the page")).getByRole("region", { name: "What happened" });
  await expect(happened.getByText("Milestone: Built")).toBeVisible();
  await expect(happened.getByText("Milestone: Committed")).toBeVisible();
  await expect(happened.getByText("Reached by Frodo")).toHaveCount(1);
  await expect(happened.getByText("Milestone: Committed").locator("..")).toContainText("Reached by Frodo");
  await scan();
});
