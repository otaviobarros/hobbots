import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, openRoom } from "./quest-room.ts";

test.afterEach(stopQuestHub);

type Tree = {
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly ownerId: string; readonly brief: string }>;
};

/**
 * Records a comment Quill's Task session posted whose answer was lost, still uncertain after the
 * last read-back (ADR 038). Posting to GitHub needs a real repository, so the test writes the record
 * the way the hub's call records would: scoped to the Task, with no chat message.
 */
const recordUncertainComment = (dataDir: string, agentId: string, taskId: string) => {
  const database = new DatabaseSync(join(dataDir, "hobbots.sqlite"));
  database.exec("PRAGMA busy_timeout = 5000");
  const at = "2026-11-02T09:00:00.000Z";
  database
    .prepare(
      `INSERT INTO charm_calls (agent_id, scope, call_key, attempt, charm, tool, input, site, plan, applied_text,
         state, result, thread_id, message_id, step_id, created_at, updated_at)
       VALUES (?, ?, 'comment-1', 'comment-1-a', 'GitHub', 'github_comment', '{}', 'github.com/octo/shop#12', '{}',
         'Commented.', 'uncertain', 'GitHub did not answer the comment in time.', NULL, NULL, NULL, ?, ?)`,
    )
    .run(agentId, `task:${taskId}`, at, at);
  database.close();
};

// covers EX-003, EX-004, IN-007
test("[TC-OR-1343-04] a Task's write whose answer was lost waits in the Quest room and the Inbox, and settles once from the lane", async ({
  page,
}) => {
  const { url, headers, dataDir, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const title = "Plan the Black Friday campaign";
  const room = await openRoom(page, title);
  await expect(lane(page, "Quill")).toContainText("Draft the landing copy");

  // Quill's Task posted a comment, and GitHub's answer was lost.
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  const read = await fetch(`${url}/api/threads/${thread}/tasks`, { headers });
  const { trees } = (await read.json()) as { readonly trees: ReadonlyArray<Tree> };
  const draft = trees.flatMap((tree) => tree.tasks).find((task) => task.brief.startsWith("Draft the landing copy"));
  if (draft === undefined) throw new Error("expected Quill's Task");
  recordUncertainComment(dataDir, draft.ownerId, draft.id);
  await page.reload();

  // It waits in the Inbox, under the Quest, with the way to the Quest room.
  const inbox = page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Inbox, / });
  await inbox.click();
  const entry = page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Quill lost GitHub's answer/ });
  await entry.click();
  const detail = page.getByRole("article", { name: "Unsure GitHub write from Quill" });
  await expect(detail).toContainText("The answer to github_comment on github.com/octo/shop#12 was lost");
  await expect(detail.getByRole("button", { name: "It went through" })).toBeEnabled();
  await expectAccessible(page, detail);

  // In the Quest room it waits in Quill's lane, lit like a question, and settles from the keyboard.
  await detail.getByRole("link", { name: "Open in the Quest room" }).click();
  const card = lane(page, "Quill").getByRole("region", { name: "Quill lost GitHub's answer" });
  await expect(room).toBeVisible();
  await expect(card).toContainText("Look on GitHub to see whether it went through");
  await expectAccessible(page, card);
  await card.getByRole("button", { name: "It went through" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: /^Notifications/ }).getByText("Settled: it went through."),
  ).toBeVisible();
  await expect(card).toBeHidden();

  // Settled once: a second settlement is refused, and nothing waits any more.
  const again = await fetch(`${url}/api/tasks/${draft.id}/charm-calls/comment-1-a/settlement`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "not-sent" }),
  });
  expect(again.status).toBe(409);
  const waiting = await fetch(`${url}/api/charm-calls/waiting`, { headers });
  expect(await waiting.json()).toEqual([]);
});
