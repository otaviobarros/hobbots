import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PromptRequest } from "@hobbots/agents";
import { GIT_INIT_TOOL, type Task, type TaskTree } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  hub,
  memberTask,
  PIP,
  project,
  promptsTo,
  ROOK,
  retry,
  send,
  sharedDatabase,
  startHub,
  taskOf,
  treeWhen,
} from "./dependency-hub.ts";

// Issue #699: a delegation promised its member `git_init`, but only chat turns were offered the
// local Git and Charm tools, so the member asked its lead to create the repository. Member and step
// sessions now offer them under their narrowed policy, by the rule the delegation announces them
// by, and a member's call is recorded on its Task as a chat turn's is. On SQLite and PostgreSQL
// (TestDatabase).

const OPENS = { decisions: { "local-git": "allow", "edit-files": "allow" } } as const;
const CLOSES = { decisions: { "local-git": "deny" } } as const;

const offered = (request: PromptRequest) => request.hubTools?.tools.map((tool) => tool.name) ?? [];

/** The first prompt sent to `task`'s session: its member's brief, or its step's. */
const firstPrompt = (requests: ReadonlyArray<PromptRequest>, task: Task) =>
  retry(
    Effect.suspend(() => {
      const [found] = promptsTo(requests, task);
      return found === undefined ? Effect.fail("not yet" as const) : Effect.succeed(found);
    }),
  );

/** The step planned under `parent`. */
const stepUnder = (tree: TaskTree, parent: Task) => tree.tasks.find((task) => task.parentId === parent.id);

describe("member and step sessions offer git_init", () => {
  // covers OR-002, PE-005
  it("[TC-OR-495] a member's and a step's session list git_init when their authority opens it, and not when it doesn't", async () => {
    const { run, requests } = await startHub(await sharedDatabase());
    const withStep = (brief: string, key: string) =>
      [brief, hub("plan_steps", { key, steps: [{ brief: `${brief}, step one` }] })].join("\n");
    await run(
      send([
        "Start the app",
        hub("delegate_task", {
          key: "repo",
          hob: "Rook",
          brief: withStep("Make the repository", "rook-plan"),
          authority: OPENS,
        }),
        hub("delegate_task", {
          key: "notes",
          hob: "Pip",
          brief: withStep("Write the notes", "pip-plan"),
          authority: CLOSES,
        }),
      ]),
    );
    const tree = await run(
      treeWhen((each) => {
        const rook = memberTask(each, ROOK);
        const pip = memberTask(each, PIP);
        return rook !== undefined && pip !== undefined && !!stepUnder(each, rook) && !!stepUnder(each, pip);
      }),
    );
    const rook = taskOf(tree, ROOK);
    const pip = taskOf(tree, PIP);

    const offeredTo = async (task: Task | undefined) => {
      if (task === undefined) throw new Error("no step");
      return offered(await run(firstPrompt(requests, task)));
    };

    expect(await offeredTo(rook)).toContain(GIT_INIT_TOOL);
    // A step offers its own Task tools besides, and nothing else.
    expect(await offeredTo(stepUnder(tree, rook))).toEqual(["report_checkpoint", "complete_task", GIT_INIT_TOOL]);
    expect(await offeredTo(pip)).not.toContain(GIT_INIT_TOOL);
    expect(await offeredTo(stepUnder(tree, pip))).not.toContain(GIT_INIT_TOOL);
  }, 30_000);

  // covers PE-005, OR-007
  it("[TC-OR-496] a member's git_init creates the repository and is recorded on its Task, as is one refused", async () => {
    const { run } = await startHub(await sharedDatabase());
    const folder = join(project, "rook-app");
    await run(
      send([
        "Start the app",
        hub("delegate_task", {
          key: "repo",
          hob: "Rook",
          brief: [
            "Make the repository",
            hub(GIT_INIT_TOOL, { folder }),
            // Already a repository now, so the second is refused.
            hub(GIT_INIT_TOOL, { folder }),
            hub("complete_task", { key: "repo-done", summary: "The repository is ready" }),
          ].join("\n"),
          authority: OPENS,
        }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
    const rook = taskOf(tree, ROOK);
    expect(existsSync(join(folder, ".git", "HEAD"))).toBe(true);
    expect(
      tree.checkpoints.filter((checkpoint) => checkpoint.taskId === rook.id).map((each) => each.summary),
    ).toContain(`${GIT_INIT_TOOL}: Created an empty Git repository in ${folder}.`);
    expect(tree.refusals).toEqual([
      expect.objectContaining({
        agentId: ROOK,
        taskId: rook.id,
        tool: GIT_INIT_TOOL,
        reason: "charm-refused",
        message: expect.stringContaining("is already a Git repository"),
      }),
    ]);
  }, 30_000);
});
