import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { laneHead, openRoom, taskDetails } from "./quest-room.ts";

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
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  const tasks = await openRoom(page, "Commit the project");
  const pip = laneHead(page, "Pip");
  await expect(pip).toContainText("Blocked", { timeout: 20_000 });

  // You ran git init yourself and tell Frodo, who reads the work and messages Pip.
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await composer.fill(
    [
      "I ran git init, so Pip can commit now",
      hubCall("read_tasks", { key: "look" }),
      hubCall("message_task", { key: "tell-pip", task_id: "$commit.task_id", text: "git init is done. Commit now." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText("Sent to hob").first()).toBeVisible({ timeout: 45_000 });

  // Pip finishes; nothing on the Quest was cancelled.
  await expect(pip).toContainText("Done", { timeout: 20_000 });
  await expect(tasks).not.toContainText("Cancelled");
  // Pip's Task holds the message in its backpack, in its details once nothing waits.
  await taskDetails(page, "Make the commit");
  const room = page.getByRole("region", { name: "Backpack for Make the commit" });
  await expect(room.getByRole("button", { name: /git init is done\. Commit now\./ })).toContainText("Consumed", {
    timeout: 20_000,
  });
});

// covers OR-002, IN-001, PE-003
test("[TC-OR-489] a lead's message while its member waits for your approval shows as held, then reaches the member once you decide", async ({
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

  // Pip's push asks you first, under Balanced, so his turn waits on your decision.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Ship the copy",
      hubCall("delegate_task", {
        key: "ship",
        hob: "Pip",
        brief: [
          "Push the copy",
          "fake:tool Bash git push origin feature",
          `fake:then ${hubCall("complete_task", { key: "ship-done", summary: "Pushed under the new name" })}`,
        ].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$ship.task_id"] }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 45_000 });

  // Frodo messages Pip meanwhile; his result says it is held and why.
  await openRoom(page, "Ship the copy");
  const pip = laneHead(page, "Pip");
  await expect(pip).toBeVisible();
  const approvals = await request<ReadonlyArray<{ readonly taskId: string | null }>>(current, "GET", "/api/approvals");
  const asked = approvals.find((each) => each.taskId !== null);
  if (asked?.taskId == null) throw new Error("Pip asked nothing");
  await composer.fill(
    [
      "Tell Pip the product is renamed",
      hubCall("message_task", { key: "rename", task_id: asked.taskId, text: "The product is now Hobbots." }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText(/Held for hob .*: their turn waits for the user to decide/).first()).toBeVisible({
    timeout: 45_000,
  });

  // On Pip's Task, the message waits for a turn to carry it, while Pip's request waits for you.
  const room = page.getByRole("region", { name: "Backpack for Push the copy" });
  const note = room.getByRole("button", { name: /The product is now Hobbots\./ });
  await expect(note).toContainText("Waiting");

  // You allow the push; Pip's turn ends, and his next one carries the message.
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const card = page
    .getByRole("article", { name: "Request from Pip: Push your work" })
    .getByRole("region", { name: "Pip asks permission" });
  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
  await page.getByRole("link", { name: "Open in the chat" }).click();
  await openRoom(page, "Ship the copy");
  await expect(pip).toContainText("Done", { timeout: 30_000 });
  // Once nothing waits, the backpack moves into the Task's details.
  await taskDetails(page, "Push the copy");
  await expect(note).toContainText("Consumed", { timeout: 20_000 });
});
