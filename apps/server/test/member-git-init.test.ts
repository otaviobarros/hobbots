import { existsSync } from "node:fs";
import { join } from "node:path";
import { Charms, type PromptRequest } from "@hobbots/agents";
import { GIT_INIT_TOOL, GITHUB_PUSH_TOOL, type Task, type TaskTree } from "@hobbots/domain";
import { waitToFind } from "@hobbots/domain/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  hub,
  memberTask,
  PIP,
  project,
  promptsTo,
  ROOK,
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
  waitToFind("the first prompt to the Task's session", () => promptsTo(requests, task)[0]);

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
            hub("complete_task", { delivered: true, key: "repo-done", summary: "The repository is ready" }),
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

  // covers PE-005, ADR 020
  it("[TC-OR-497] a member is offered the GitHub Charm's reads but not its writes, which have no reply to be settled on", async () => {
    const called: Array<string> = [];
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" }, label: name });
    // The registry leaves a Charm's writes out of a turn that has no reply to settle them on.
    const charms = Layer.succeed(
      Charms,
      Charms.of({
        charms: [],
        forTurn: (_turn, offer) =>
          Effect.succeed([
            {
              owner: "the GitHub Charm",
              tools: {
                tools: offer?.writes === false ? [tool("github_item")] : [tool("github_item"), tool(GITHUB_PUSH_TOOL)],
                call: (name) =>
                  Effect.sync(() => {
                    called.push(name);
                    return { text: "Done.", refused: false };
                  }),
              },
            },
          ]),
      }),
    );
    const { run, requests } = await startHub(await sharedDatabase(), [], charms);
    await run(
      send([
        "Publish the app",
        hub("delegate_task", {
          key: "push",
          hob: "Rook",
          brief: [
            "Push the app",
            hub(GITHUB_PUSH_TOOL, { key: "push-it", folder: project }),
            hub("complete_task", { delivered: true, key: "push-done", summary: "Could not push" }),
          ].join("\n"),
          authority: OPENS,
        }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
    const rook = taskOf(tree, ROOK);

    const offeredToRook = offered(await run(firstPrompt(requests, rook)));
    expect(offeredToRook).toContain("github_item");
    expect(offeredToRook).not.toContain(GITHUB_PUSH_TOOL);
    // The lead's chat turn, whose reply a lost answer is settled on, still offers it.
    expect(offered(requests[0] as PromptRequest)).toContain(GITHUB_PUSH_TOOL);
    // Rook's push never reached the Charm, and its refusal is on Rook's Task.
    expect(called).toEqual([]);
    expect(tree.refusals).toEqual([
      expect.objectContaining({ agentId: ROOK, taskId: rook.id, tool: GITHUB_PUSH_TOOL, reason: "unknown-tool" }),
    ]);
  }, 30_000);
});
