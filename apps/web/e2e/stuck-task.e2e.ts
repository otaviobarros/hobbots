import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { cancelInLane, lane, laneHead, laneMenu, openRoom } from "./quest-room.ts";

// Issue #1087 in the browser: a member's Task whose work is stuck reads and acts the same on its
// lane, its card in the Quest room and the Inbox, and its stuck work closes once nothing is left to choose.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
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

const hobNamed = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
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

/**
 * Aldric brings in Quill, whose one try at the copy is cut off, so it is stuck: each item has one
 * delivery here. The cut-off runs once, so whoever takes the copy next gets through it.
 */
const stuckCopy = async (page: import("@playwright/test").Page, after: ReadonlyArray<string> = []) => {
  dataDir = emptyDataDir();
  const current = await startHub(dataDir, { HOBBOTS_BACKPACK_MAX_DELIVERIES: "1" });
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Quill", 4821);
  await hobNamed(current, "Pip", 5150);
  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Plan the launch",
      script("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: ["Draft the landing copy", "fake:once fake:fail", ...after].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });
  return current;
};

// covers IN-007, OR-006, UX-004
test("[TC-IN-1087-02] a stuck member's lane says Stuck with Retry, and Reassign… on its Inbox card hands the Task on and clears the stuck work", async ({
  page,
}) => {
  const current = await stuckCopy(page);
  const thread = page.url();
  await openRoom(page, "Plan the launch");
  await expect(laneHead(page, "Quill")).toContainText("Stuck");
  const menu = await laneMenu(page, "Quill");
  await expect(menu.getByRole("menuitem", { name: "Retry" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Reassign…" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`${current.url}/#/inbox`);
  await page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Stuck/ }).click();
  const card = page.getByRole("article", { name: /^Quill's work is stuck/ });
  await card.getByRole("button", { name: "Reassign…" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Pip" }).click();
  await expect(page.getByText("Gave the task to Pip.", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing needs you")).toBeVisible();

  // The room agrees: Pip has the Task, and Quill's lane no longer says it is stuck.
  await page.goto(thread);
  await openRoom(page, "Plan the launch");
  await expect(lane(page, "Pip")).toBeVisible();
  await expect(page.getByRole("region", { name: "Lanes" })).not.toContainText("Stuck");
});

// covers IN-007, OR-006
test("[TC-IN-1087-03] cancelling a stuck member's Task from its lane closes its stuck work, so nothing needs you", async ({
  page,
}) => {
  const current = await stuckCopy(page);
  await openRoom(page, "Plan the launch");
  await expect(laneHead(page, "Quill")).toContainText("Stuck");
  await cancelInLane(page, "Quill");
  await expect(laneHead(page, "Quill")).not.toContainText("Stuck");
  await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
  await page.goto(`${current.url}/#/inbox`);
  await expect(page.getByText("Nothing needs you")).toBeVisible();
});

// covers IN-007, UX-004
test("[TC-IN-1087-04] says when Retry in a stuck lane is not saved, and when the card cannot read whether the Task can change hands", async ({
  page,
}) => {
  const current = await stuckCopy(page);

  // The hub does not save Retry: the menu closes, and Quill's lane says why under the Task.
  await page.route(/\/api\/blockers\/[^/]+\/decision$/, (route) => route.fulfill({ status: 500, body: "" }));
  await openRoom(page, "Plan the launch");
  const menu = await laneMenu(page, "Quill");
  await menu.getByRole("menuitem", { name: "Retry" }).click();
  await expect(lane(page, "Quill").getByRole("alert")).toContainText("Hobbots could not save that.");
  await page.unroute(/\/api\/blockers\/[^/]+\/decision$/);

  // The card cannot read the thread's Tasks: it says so, never that nobody else can take it.
  let failing = true;
  await page.route(/\/api\/threads\/[^/]+\/tasks$/, async (route) => {
    if (failing) await route.fulfill({ status: 500, body: "" });
    else await route.continue();
  });
  // A fresh load, so the room's read of the Tasks is not kept.
  await page.goto(`${current.url}/#/inbox`);
  await page.reload();
  await page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Stuck/ }).click();
  const card = page.getByRole("article", { name: /^Quill's work is stuck/ });
  const unread = card.getByRole("alert");
  await expect(unread).toContainText("could not read whether another hob can take this", { timeout: 20_000 });
  await expect(card.getByRole("button", { name: "Reassign…" })).toHaveCount(0);
  failing = false;
  await unread.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("button", { name: "Reassign…" })).toBeVisible();
});

// covers IN-007, UX-004
test("[TC-IN-1087-05] Retry in a stuck lane gives the hob a fresh try, which finishes the Task, so the lane and the Inbox stop saying it is stuck", async ({
  page,
}) => {
  // The try that is cut off keeps the completion for the session's next turn: only the fresh try
  // Retry sends can finish the Task, so its result shows that the try ran.
  const finish = script("complete_task", { delivered: true, key: "copy-done", summary: "Three headlines." });
  const current = await stuckCopy(page, [`fake:once fake:then ${finish}`]);
  await openRoom(page, "Plan the launch");
  await expect(laneHead(page, "Quill")).toContainText("Stuck");
  // The cut-off try finished nothing: no result yet, only the failed first Attempt.
  await expect(lane(page, "Quill")).not.toContainText("Result · ");
  await expect(lane(page, "Quill")).toContainText("Attempt 1 failed.");
  const sent = page.waitForResponse(
    (response) => /\/api\/blockers\/[^/]+\/decision$/.test(response.url()) && response.ok(),
  );
  await (await laneMenu(page, "Quill")).getByRole("menuitem", { name: "Retry" }).click();
  await sent;
  // The fresh try runs and finishes the Task with its result, and the stuck work leaves the lane and the Inbox.
  await expect(lane(page, "Quill")).toContainText("Result · Three headlines.", { timeout: 20_000 });
  await expect(laneHead(page, "Quill")).not.toContainText("Stuck");
  await expect(lane(page, "Quill").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
  await expect((await laneMenu(page, "Quill")).getByRole("menuitem", { name: "Retry" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`${current.url}/#/inbox`);
  await expect(page.getByText("Nothing needs you")).toBeVisible();
});
