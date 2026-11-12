import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #352 in the browser: an approval for This task, which the card calls This quest once a party
// joins the Task. The hub-level side is apps/server/test/task-grants.test.ts.

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
    // As the hub's window, with its key: approvals answer only the user (PE-006).
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

/** A hub under Balanced, where pushing asks, with Aldric and Quill; Aldric's chat is open. */
const aldricsChat = async (page: Page) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Quill", 4821);
  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
  return { current, composer: page.getByRole("textbox", { name: /^Message Aldric/ }) };
};

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
const PUSH = "fake:tool Bash git push origin feature";

type Grants = ReadonlyArray<{ readonly agentId: string; readonly lifetime: string; readonly taskId: string | null }>;

// covers PE-007, OR-001
test("[TC-IN-152] a request made in a Task offers This task, shows the rule it saves, and the next push runs without asking", async ({
  page,
}) => {
  const { current, composer } = await aldricsChat(page);
  const stop = page.getByRole("button", { name: /Stop/ });

  // Aldric starts a Task whose step keeps working, so the Task stays open.
  await composer.fill(
    ["Plan the launch", script("plan_steps", { key: "plan", steps: [{ brief: "fake:tool Bash sleep 600" }] })].join(
      "\n",
    ),
  );
  await composer.press("Enter");
  await expect(stop).toBeVisible();
  await expect(stop).toBeHidden();

  // His push in that Task asks, and the card offers This task between Allow once and Always.
  await composer.fill(["Push the branch", PUSH].join("\n"));
  await composer.press("Enter");
  const card = page.getByRole("region", { name: "Aldric asks permission" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button")).toHaveText(["Allow once", "This task", "Always for this branch", "Deny"]);
  await card.getByRole("button", { name: "This task" }).click();
  const form = card.getByRole("form", { name: "This task" });
  await expect(form).toContainText("Hobbots saves this rule for this task only.");
  await expect(form.getByRole("list", { name: "The rule to save" })).toHaveText([
    `For this task, let Aldric push ${shared} to feature on origin`,
  ]);
  // Escape goes back to the choices, with focus on This task.
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "This task" })).toBeFocused();
  await card.getByRole("button", { name: "This task" }).click();
  await form.getByRole("button", { name: "Save for this task and allow" }).click();
  await expect(card.getByRole("status")).toHaveText(
    "✓ Allowed for the rest of this task. Aldric carries on, and asks again once the task ends.",
  );
  await expect(stop).toBeHidden();

  // The same push later in the Task runs on that grant: no new card.
  await composer.fill(["Push again", PUSH].join("\n"));
  await composer.press("Enter");
  await expect(stop).toBeVisible();
  await expect(stop).toBeHidden();
  await expect(page.getByRole("region", { name: "Aldric asks permission" })).toHaveCount(1);
  const approvals = await api<ReadonlyArray<{ readonly lifetime: string | null }>>(current, "GET", "/api/approvals");
  expect(approvals.map(({ lifetime }) => lifetime)).toEqual(["task"]);
  const grants = await api<Grants>(current, "GET", "/api/grants");
  expect(grants.map(({ lifetime, taskId }) => [lifetime, taskId !== null])).toEqual([["task", true]]);
});

// covers PE-004, PE-006, PE-007
test("[TC-IN-153] a party member's request in the Inbox offers This quest, and its grant answers only that member", async ({
  page,
}) => {
  const { current, composer } = await aldricsChat(page);

  // Aldric brings in Quill, whose Task pushes twice; Quill asks you in the Inbox, under Aldric's thread.
  await composer.fill(
    [
      "Plan the launch",
      script("delegate_task", { key: "ship", hob: "Quill", brief: ["Ship the copy", PUSH, PUSH].join("\n") }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click({ timeout: 20_000 });
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const detail = page.getByRole("article", { name: "Request from Quill: Push your work" });
  const card = detail.getByRole("region", { name: "Quill asks permission" });

  // A party joined the Task, so the same lifetime reads This quest.
  await expect(card.getByRole("button", { name: "This quest" })).toBeVisible();
  await expect(card.getByRole("button", { name: "This task" })).toHaveCount(0);
  await card.getByRole("button", { name: "This quest" }).click();
  const form = card.getByRole("form", { name: "This quest" });
  await expect(form).toContainText("Other hobs on the quest still ask.");
  await expect(form.getByRole("list", { name: "The rule to save" })).toHaveText([
    `For this quest, let Quill push ${shared} to feature on origin`,
  ]);
  await form.getByRole("button", { name: "Save for this quest and allow" }).click();
  await expect(card.getByRole("status")).toHaveText(
    "✓ Allowed for the rest of this task. Quill carries on, and asks again once the task ends.",
  );

  // Quill's second push runs on his grant, so nothing else waits on you.
  await expect(page.getByRole("link", { name: /waiting on you$/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("region", { name: "Decision history" }).locator('[data-state="approved"]')).toContainText(
    "Task",
  );
  const grants = await api<Grants>(current, "GET", "/api/grants");
  expect(grants.map(({ agentId, lifetime }) => [agentId, lifetime])).toEqual([[expect.any(String), "task"]]);
  const approvals = await api<ReadonlyArray<{ readonly agentId: string; readonly state: string }>>(
    current,
    "GET",
    "/api/approvals",
  );
  expect(approvals.map(({ state }) => state)).toEqual(["approved"]);
  expect(grants[0]?.agentId).toBe(approvals[0]?.agentId);
});
