import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { lane, openRoom } from "./quest-room.ts";

// Issue #909 in the browser: a message you send the lead while work runs gets a steer receipt
// under it, "Aldric got it → Ada picked it up", and your note shows as chips in the Quest room's
// lanes. The hub's side is apps/server/test/steer-receipts.test.ts.

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

const summon = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
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

/** A prompt line that makes the fake call a Hobbots tool. */
const hubCall = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/**
 * A delegation whose member reports a blocker and stops, so its Task waits for word from its lead
 * and a note wakes its next turn: its milestone is never reached, so its turn's end does not
 * complete it.
 */
const stuck = (key: string, hob: string, brief: string) =>
  hubCall("delegate_task", {
    key,
    hob,
    milestones: ["Settled"],
    brief: [
      brief,
      hubCall("report_checkpoint", { key: `${key}-stuck`, kind: "blocker", summary: "The design is not settled" }),
    ].join("\n"),
  });

interface Tasks {
  readonly trees: ReadonlyArray<{
    readonly tasks: ReadonlyArray<{ readonly id: string; readonly ownerId: string; readonly state: string }>;
  }>;
}

/** Aldric's party, past setup with a folder they may work in. */
const party = async (names: ReadonlyArray<string>) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const ids: Record<string, string> = {};
  for (const [index, name] of ["Aldric", ...names].entries())
    ids[name] = (await summon(current, name, 4000 + index * 911)).id;
  return { current, ids };
};

/**
 * Sends a message to Aldric once his running turn, if any, has ended, and waits until his turn on
 * it ends. A member's blocker starts a turn of his that echoes its briefing word by word, so it can
 * run for a while.
 */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const stop = page.getByRole("button", { name: /Stop/ });
  await expect(stop).toBeHidden({ timeout: 90_000 });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 30_000 });
  await composer.press("Enter");
  await expect(stop).toBeHidden({ timeout: 90_000 });
};

/** Starts Aldric's request and waits until each named member's Task is in `state`, giving back their Task ids. */
const startWork = async (
  page: Page,
  current: Hub,
  ids: Record<string, string>,
  request: ReadonlyArray<string>,
  members: ReadonlyArray<string>,
  state: string,
) => {
  await page.goto(`${current.url}/#/hobs/${ids.Aldric}/new`);
  await send(page, request);
  await expect(page).toHaveURL(/\/threads\//);
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  const taskIds: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        const { trees } = await api<Tasks>(current, "GET", `/api/threads/${thread}/tasks`);
        const tasks = trees.flatMap((tree) => tree.tasks);
        for (const name of members) {
          const task = tasks.find((each) => each.ownerId === ids[name] && each.state === state);
          if (task !== undefined) taskIds[name] = task.id;
        }
        return members.every((name) => taskIds[name] !== undefined);
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  return { thread, taskIds };
};

/** The steer receipt under your latest message. */
const receipt = (page: Page): Locator => page.getByRole("region", { name: "Where your message went" }).last();

/** What the receipt says to a screen reader, one sentence per step. */
const said = (page: Page): Locator => receipt(page).getByRole("status");

/** Your notes in a hob's lane. */
const notes = (page: Page, name: string): Locator => lane(page, name).getByRole("list", { name: "Your notes" });

// covers OR-002, UX-006
test("[TC-UX-260] a message the lead passes to one hob reads got it, then picked up, in the chat and in the lanes", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { current, ids } = await party(["Ada"]);
  const { taskIds } = await startWork(
    page,
    current,
    ids,
    [
      "Build the site",
      stuck("pages", "Ada", "Build the pages"),
      hubCall("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
    ],
    ["Ada"],
    "blocked",
  );

  await send(page, [
    "Use the blue theme",
    hubCall("message_task", { key: "steer", task_id: taskIds.Ada, text: "Use the blue theme." }),
  ]);
  // In the full-width chat, the receipt follows the note to Ada's turn, which picks it up.
  await expect(receipt(page)).toContainText("Aldric got it →");
  await expect(receipt(page)).toContainText("Ada picked it up", { timeout: 45_000 });
  await expect(said(page)).toHaveText("Aldric got your message. Ada picked it up.");
  // Each step is its own sentence in a live region that is not atomic, so only a changed step is read.
  await expect(said(page)).toHaveAttribute("aria-atomic", "false");

  // The room's chat column shows the same receipt, and the lanes show your note where it went.
  await openRoom(page, "Build the site");
  await expect(receipt(page)).toContainText("Ada picked it up");
  await expect(notes(page, "Aldric").getByRole("listitem")).toHaveText([
    /Your note: Use the blue theme/,
    /Passed it to Ada$/,
  ]);
  await expect(notes(page, "Ada").getByRole("listitem")).toHaveText([/Your note, via Aldric$/]);
});

// covers OR-002, UX-006
test("[TC-UX-261] a message the lead passes to two hobs names each, and each picks it up", async ({ page }) => {
  test.setTimeout(240_000);
  const { current, ids } = await party(["Quill", "Ada"]);
  const { taskIds } = await startWork(
    page,
    current,
    ids,
    [
      "Ship the launch",
      stuck("copy", "Quill", "Write the copy"),
      stuck("pages", "Ada", "Build the pages"),
      hubCall("wait_for", { key: "wait", tasks: ["$copy.task_id", "$pages.task_id"] }),
    ],
    ["Quill", "Ada"],
    "blocked",
  );

  await send(page, [
    "Launch on Friday",
    hubCall("message_task", { key: "tell-quill", task_id: taskIds.Quill, text: "We launch on Friday." }),
    hubCall("message_task", { key: "tell-ada", task_id: taskIds.Ada, text: "We launch on Friday." }),
  ]);
  await expect(said(page)).toHaveText("Aldric got your message. Quill picked it up. Ada picked it up.", {
    timeout: 45_000,
  });
  await expect(receipt(page)).toContainText("Quill picked it up");
  await expect(receipt(page)).toContainText("Ada picked it up");

  await openRoom(page, "Ship the launch");
  await expect(notes(page, "Aldric").getByRole("listitem").last()).toHaveText(/Passed it to Quill and Ada$/);
  await expect(notes(page, "Quill").getByRole("listitem")).toHaveText([/Your note, via Aldric$/]);
  await expect(notes(page, "Ada").getByRole("listitem")).toHaveText([/Your note, via Aldric$/]);
});

// covers OR-002, UX-006
test("[TC-UX-262] a message the lead answers without passing on stops at got it", async ({ page }) => {
  test.setTimeout(240_000);
  const { current, ids } = await party(["Ada"]);
  await startWork(
    page,
    current,
    ids,
    [
      "Build the site",
      stuck("pages", "Ada", "Build the pages"),
      hubCall("wait_for", { key: "wait", tasks: ["$pages.task_id"] }),
    ],
    ["Ada"],
    "blocked",
  );

  await send(page, ["How is it going?", hubCall("read_tasks", { key: "look" })]);
  // His turn on it echoes his briefing word by word, and reads your message until it ends.
  await expect(said(page)).toHaveText("Aldric got your message.", { timeout: 90_000 });
  await expect(receipt(page)).toContainText("Aldric got it");
  await expect(receipt(page)).not.toContainText("→");

  await openRoom(page, "Build the site");
  await expect(notes(page, "Aldric").getByRole("listitem")).toHaveText([/Your note: How is it going\?$/]);
  await expect(notes(page, "Ada")).toHaveCount(0);
});

// covers OR-002, PE-003, UX-006
test("[TC-UX-263] a note held while its hob waits on your approval says so, and is picked up once you decide", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { current, ids } = await party(["Quill"]);
  const { thread, taskIds } = await startWork(
    page,
    current,
    ids,
    [
      "Ship the copy",
      hubCall("delegate_task", { key: "ship", hob: "Quill", brief: "Ship it\nfake:tool Bash git push origin feature" }),
      hubCall("wait_for", { key: "wait", tasks: ["$ship.task_id"] }),
    ],
    ["Quill"],
    "active",
  );
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 30_000 });

  await send(page, [
    "Tell Quill the product is renamed",
    hubCall("message_task", { key: "rename", task_id: taskIds.Quill, text: "The product is now Hobbots." }),
  ]);
  await expect(receipt(page)).toContainText(/Held: Quill is waiting on your approval: /, { timeout: 30_000 });
  await expect(said(page)).toContainText("Your note is held: Quill is waiting on your approval: ");

  // Once you decide, Quill's next turn picks the note up.
  const [pending] = await api<ReadonlyArray<{ readonly id: string; readonly actionDigest: string }>>(
    current,
    "GET",
    `/api/approvals`,
  );
  if (pending === undefined) throw new Error(`no approval request in ${thread}`);
  await api(current, "POST", `/api/approvals/${pending.id}/decision`, {
    decision: "approve",
    actionDigest: pending.actionDigest,
  });
  await expect(receipt(page)).toContainText("Quill picked it up", { timeout: 45_000 });
  await expect(said(page)).toHaveText("Aldric got your message. Quill picked it up.");
});
