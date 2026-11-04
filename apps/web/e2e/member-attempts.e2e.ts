import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #668 in the browser: Pip leads a nested Quest and is woken several times on his Task. Each
// wake is a turn of his Task's one Attempt, so his Workbench offers no Attempt to pick. The hub's
// side is tested in apps/server/test/member-attempts.test.ts.

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

/** Sends Frodo a message once his last turn has ended. */
const tellFrodo = async (page: Page, lines: ReadonlyArray<string>) => {
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 45_000 });
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
};

// covers EX-001, OR-004, UX-002
test("[TC-OR-454] a nested lead woken several times on its Task shows Attempt 1 only in its Workbench", async ({
  page,
}) => {
  // Every lead turn's briefing is echoed word by word, so its turns take longer than a member's.
  test.setTimeout(150_000);
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

  // Pip starts a Quest of his own and rests on his milestone; each of Frodo's messages wakes him,
  // and the third turn they start reports it and finishes.
  const later = (turns: number, line: string) => `${"fake:then ".repeat(turns)}${line}`;
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  await tellFrodo(page, [
    "Review the project",
    hubCall("delegate_task", {
      key: "review",
      hob: "Pip",
      milestones: ["Reviewed"],
      brief: [
        "Review the work",
        hubCall("start_quest", { key: "nested", goal: "Review and commit the project" }),
        later(1, hubCall("report_checkpoint", { key: "one", kind: "progress", summary: "Read the first note" })),
        later(2, hubCall("report_checkpoint", { key: "two", kind: "progress", summary: "Read the second note" })),
        later(
          3,
          hubCall("report_checkpoint", {
            key: "reviewed",
            kind: "milestone",
            summary: "Reviewed",
            milestone_id: "$review.milestones.0",
          }),
        ),
        later(3, hubCall("complete_task", { key: "review-done", summary: "Reviewed the project" })),
      ].join("\n"),
    }),
    hubCall("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
  ]);
  await page.getByRole("tab", { name: "Quest" }).click();
  const tasks = page.getByRole("list", { name: /^Tasks of Review the project/ });
  const pip = tasks.getByRole("button", { name: /^Pip · Review the work/ });
  await expect(pip).toContainText("Blocked", { timeout: 30_000 });

  for (const [key, text] of [
    ["first", "Here is the first note."],
    ["second", "Here is the second note."],
    ["third", "That is all. Wrap up."],
  ] as const) {
    await tellFrodo(page, [
      `Pass Pip a note: ${text}`,
      hubCall("message_task", { key, task_id: "$review.task_id", text }),
    ]);
    await expect(page.getByText("Sent to hob").first()).toBeVisible({ timeout: 45_000 });
    if (key !== "third") await expect(pip).toContainText("Blocked", { timeout: 30_000 });
  }
  await expect(pip).toContainText("Done", { timeout: 30_000 });

  // The hub kept one Attempt of Pip's Task for all his turns, ended once his last turn is.
  const thread = /\/threads\/([^/?]+)/.exec(page.url())?.[1];
  const pipAttempts = async () => {
    const { trees } = await request<{
      readonly trees: ReadonlyArray<{
        readonly tasks: ReadonlyArray<{ readonly id: string; readonly parentId: string | null }>;
        readonly attempts: ReadonlyArray<{ readonly taskId: string; readonly number: number; readonly state: string }>;
      }>;
    }>(current, "GET", `/api/threads/${thread}/tasks`);
    const pipTask = trees[0]?.tasks.find((task) => task.parentId !== null);
    return trees[0]?.attempts
      .filter((attempt) => attempt.taskId === pipTask?.id)
      .map(({ number, state }) => ({ number, state }));
  };
  await expect.poll(pipAttempts, { timeout: 20_000 }).toEqual([{ number: 1, state: "completed" }]);

  // His Workbench offers no Attempt to pick.
  await pip.click();
  const room = page.getByRole("region", { name: "Control room for Review the project" });
  await room
    .getByRole("region", { name: "Controls for Review the work" })
    .getByRole("button", { name: "Open in Workbench" })
    .click();
  const bench = page.getByRole("region", { name: "Workbench for Review the work" });
  await expect(bench.getByRole("heading", { name: "Review the work" })).toBeVisible();
  await expect(bench.getByRole("radiogroup", { name: "Attempts" })).toHaveCount(0);
});
