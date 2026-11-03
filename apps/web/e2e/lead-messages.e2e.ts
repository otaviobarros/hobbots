import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #574 in the browser: a member is stuck on something outside Hobbots; once it clears, you
// tell its lead, who messages the member, and the member finishes with nothing cancelled. The hub's
// side, a nested Quest included, is tested in apps/server/test/lead-reads-and-messages.test.ts.

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

// covers OR-002, OR-006, IN-001, IN-004
test("[TC-OR-251] once the obstacle clears, the lead's message wakes the blocked member, which finishes with nothing cancelled", async ({
  page,
}) => {
  // Every lead turn's briefing is echoed word by word, so its turns take longer than a member's.
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

  // Pip can't commit until git init runs, and ends his turn blocked. His next turn is the one
  // Frodo's message starts.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Commit the project",
      hubCall("delegate_task", {
        key: "commit",
        hob: "Pip",
        milestones: ["Committed"],
        brief: [
          "Make the commit",
          hubCall("report_checkpoint", { key: "denied", kind: "blocker", summary: "git init is denied" }),
          `fake:then ${hubCall("report_checkpoint", { key: "committed", kind: "milestone", summary: "Committed", milestone_id: "$commit.milestones.0" })}`,
          `fake:then ${hubCall("complete_task", { key: "commit-done", summary: "One local commit" })}`,
        ].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$commit.task_id"] }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await page.getByRole("tab", { name: "Quest" }).click();
  const tasks = page.getByRole("list", { name: /^Tasks of Commit the project/ });
  const pip = tasks.getByRole("button", { name: /^Pip · Make the commit/ });
  await expect(pip).toContainText("Blocked", { timeout: 20_000 });

  // You ran git init yourself and tell Frodo, who reads the work and messages Pip.
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await composer.fill(
    [
      "I ran git init, so Pip can commit now",
      hubCall("read_tasks", { key: "look" }),
      hubCall("message_task", { key: "tell-pip", task_id: "$commit.task_id", text: "git init is done. Commit now." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText("Sent to hob").first()).toBeVisible({ timeout: 45_000 });

  // Pip finishes; nothing on the Quest was cancelled.
  await expect(pip).toContainText("Done", { timeout: 20_000 });
  await expect(tasks).not.toContainText("Cancelled");
  const room = page.getByRole("region", { name: "What hobs on Commit the project are waiting on" });
  await expect(room.getByRole("button", { name: /git init is done\. Commit now\./ })).toContainText("Consumed", {
    timeout: 20_000,
  });
});
