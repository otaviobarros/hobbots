import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { laneHead, openRoom } from "./quest-room.ts";

// Issue #1006 in the browser: a lead's reply to work that arrived while its Quest runs is routine
// progress, which the room shows. The chat keeps the plan and leaves that reply out, also after a
// reload. The hub's side is tested in apps/server/test/quiet-replies.test.ts.

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

/** How a continuation's prompt starts, which the fake echoes in its reply. */
const CONTINUATION = "Hobbots wrote this, not the user.";

// covers UX-006, OR-004
test("[TC-UX-225] the chat keeps the lead's plan and leaves out its routine progress while the Quest runs (#1006)", async ({
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
  await summon(current, "Quill", 4300);
  await summon(current, "Pip", 4821);

  // Quill finishes and Pip stops on a blocker, so Frodo is woken while the Quest still runs.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Ship the launch",
      hubCall("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Write the copy",
          hubCall("complete_task", { delivered: true, key: "copy-done", summary: "Copy written" }),
        ].join("\n"),
      }),
      hubCall("delegate_task", {
        key: "pages",
        hob: "Pip",
        milestones: ["Built"],
        brief: [
          "Build the pages",
          hubCall("report_checkpoint", { key: "stuck", kind: "blocker", summary: "The design is not settled" }),
        ].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$copy.task_id", "$pages.task_id"] }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await openRoom(page, "Ship the launch");
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 30_000 });
  await expect(laneHead(page, "Pip")).toContainText("Blocked", { timeout: 30_000 });

  // The hub keeps Frodo's progress, quiet, once his turn on it has ended.
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  type Reply = { readonly role: string; readonly status: string; readonly content: string; readonly quiet: boolean };
  const progress = async () =>
    (await request<ReadonlyArray<Reply>>(current, "GET", `/api/threads/${thread}/messages`)).filter(
      (each) => each.role === "assistant" && each.content.includes(CONTINUATION) && each.status === "complete",
    );
  await expect.poll(async () => (await progress()).length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect((await progress()).every((each) => each.quiet)).toBe(true);

  // The chat shows your request and Frodo's plan, and nothing of the progress, also after a reload.
  const chat = page.getByRole("main", { name: "Chat" });
  for (const _ of [0, 1]) {
    await expect(chat.getByText("Ship the launch").first()).toBeVisible();
    await expect(chat.getByText(/Delegated Task/).first()).toBeVisible();
    await expect(chat.getByText(CONTINUATION)).toHaveCount(0);
    await page.reload();
  }
});
