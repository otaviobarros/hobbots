import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${hub?.url}/api${path}`, {
    method,
    headers: { "content-type": "application/json", origin: String(hub?.url) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

const summon = (name: string, seed: number) =>
  call<{ readonly id: string }>("POST", "/agents", {
    id: randomUUID(),
    name,
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: "pointed",
    tool: "none",
    lookSeed: seed,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  }).then((hob) => hob.id);

/**
 * Aldric leads the Black Friday campaign from his thread: Quill drafts the copy and Ada waits to
 * build the page. Ada leads her own Quest inside it, with Pip finding keywords; it is still
 * followed in Aldric's thread. The hob tools that write these records arrive with #271, so the test writes them
 * as the repository would.
 */
const campaign = (ids: { aldric: string; quill: string; ada: string; pip: string }, threadId: string) => {
  const database = new DatabaseSync(join(dataDir, "hobbots.sqlite"));
  const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 9, 0, second)).toISOString();
  const task = (id: string, owner: string, parent: string | null, state: string, second: number) =>
    database
      .prepare(
        `INSERT INTO tasks (id, owner_id, parent_id, root_id, thread_id, brief, state, created_at, updated_at, revision)
         VALUES (?, ?, ?, 'campaign', ?, ?, ?, ?, ?, 1)`,
      )
      .run(id, owner, parent, threadId, `Brief for ${id}`, state, at(second), at(second));
  const delegation = (
    child: string,
    member: string,
    second: number,
    on = { quest: "q1", lead: ids.aldric, parent: "campaign" },
  ) =>
    database
      .prepare(
        `INSERT INTO delegations (id, quest_id, lead_id, member_id, parent_task_id, child_task_id, brief, authority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `d-${child}`,
        on.quest,
        on.lead,
        member,
        on.parent,
        child,
        `Brief for ${child}`,
        JSON.stringify({ overrides: {}, folders: null }),
        at(second),
      );
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    task("campaign", ids.aldric, null, "active", 0);
    database
      .prepare(
        `INSERT INTO quests (id, task_id, lead_id, thread_id, goal, limits, depth, state, created_at, revision)
         VALUES ('q1', 'campaign', ?, ?, 'Black Friday campaign', ?, 1, 'active', ?, 1)`,
      )
      .run(ids.aldric, threadId, JSON.stringify({ maxDepth: 2, deadline: null }), at(0));
    task("copy", ids.quill, "campaign", "active", 1);
    delegation("copy", ids.quill, 1);
    task("build", ids.ada, "campaign", "queued", 2);
    delegation("build", ids.ada, 2);
    database
      .prepare(
        `INSERT INTO quests (id, task_id, lead_id, parent_quest_id, thread_id, goal, limits, depth, state, created_at, revision)
         VALUES ('q2', 'build', ?, 'q1', ?, 'Landing page keywords', ?, 2, 'active', ?, 1)`,
      )
      .run(ids.ada, threadId, JSON.stringify({ maxDepth: 2, deadline: null }), at(3));
    task("keywords", ids.pip, "build", "active", 4);
    delegation("keywords", ids.pip, 4, { quest: "q2", lead: ids.ada, parent: "build" });
  } finally {
    database.close();
  }
};

// covers UX-001, CH-005, OR-001
test("[TC-UX-020] Home and Quill's panel show her Task on Aldric's quest and open the Quest, never as her thread", async ({
  page,
}) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  await call("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids = {
    aldric: await summon("Aldric", 1001),
    quill: await summon("Quill", 1338),
    ada: await summon("Ada", 1675),
    pip: await summon("Pip", 2012),
  };
  const thread = await call<{ readonly id: string }>("POST", `/agents/${ids.aldric}/threads`);
  campaign(ids, thread.id);
  const questThread = new RegExp(`/hobs/${ids.aldric}/threads/${thread.id}$`);

  await page.goto(hub.url);
  const quests = page.getByRole("region", { name: "Quests in progress" });
  const entry = quests.getByRole("link", { name: /Black Friday campaign/ });
  await expect(entry).toContainText("0 of 2 done");
  await expect(entry).toContainText(/Quill\s*On Aldric's quest\s*Working/);
  await expect(entry).toContainText(/Ada\s*On Aldric's quest\s*Not started/);
  await entry.click();
  await expect(page).toHaveURL(questThread);

  await page.goto(`${hub.url}/#/hobs/${ids.quill}`);
  const panel = page.getByRole("navigation", { name: "Hobs and threads" });
  const work = panel.getByRole("link", { name: "Quill is on Aldric's quest, Working. Open the Quest" });
  await expect(work).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Ada is on Aldric's quest, Not started. Open the Quest" }),
  ).toBeVisible();
  // Aldric leads it, so it is not his work as a member.
  await expect(panel.getByRole("link", { name: /^Aldric is on/ })).toHaveCount(0);
  // Quill's work is not one of her threads.
  expect(await call<ReadonlyArray<unknown>>("GET", `/agents/${ids.quill}/threads`)).toEqual([]);
  await work.click();
  await expect(page).toHaveURL(questThread);

  // Ada leads Pip's nested Quest, but it is followed in Aldric's thread, so the link opens his chat.
  const nested = panel.getByRole("link", { name: "Pip is on Ada's quest, Working. Open the Quest" });
  await nested.click();
  await expect(page).toHaveURL(questThread);
  await expect(page.getByRole("main", { name: "Chat" }).locator("header")).toContainText("Aldric");
  await page.goto(hub.url);
  const keywords = quests.getByRole("link", { name: /Landing page keywords/ });
  await expect(keywords).toContainText(/Pip\s*On Ada's quest\s*Working/);
  await keywords.click();
  await expect(page).toHaveURL(questThread);
});
