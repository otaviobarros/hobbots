import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Charm, Charms, type PromptRequest } from "@hobbots/agents";
import { fakeCharm, memoryCharmCalls } from "@hobbots/agents/testing";
import { type CharmCall, EMPTY_HOB_POLICY, GIT_INIT_TOOL, type Task, type TaskTree } from "@hobbots/domain";
import { waitToFind } from "@hobbots/domain/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  givePolicy,
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

  // covers PE-005, ADR 020, ADR 038
  it("[TC-OR-497] a member is offered the writes of a Charm that offers them outside chats, and only the reads of one that does not", async () => {
    const rows = new Map<string, CharmCall>();
    // The Ledger Charm offers its writes outside chats, as the GitHub Charm does; the Shelf Charm does not.
    const charms = Charms.layer([
      fakeCharm({ id: "shelf", name: "Shelf" }),
      Effect.map(
        fakeCharm({ id: "ledger", name: "Ledger" }),
        (ledger): Charm => ({ ...ledger, writesOutsideChats: true }),
      ),
    ]).pipe(Layer.provide(memoryCharmCalls(rows)));
    const { run, requests } = await startHub(await sharedDatabase(), [], charms);
    await run(givePolicy({ ...EMPTY_HOB_POLICY, charms: { granted: ["shelf", "ledger"] } }));
    await run(
      send([
        "Keep the books",
        hub("delegate_task", {
          key: "books",
          hob: "Rook",
          brief: [
            "Write it down",
            hub("shelf_write", { key: "shelf-1" }),
            hub("ledger_write", { key: "ledger-1" }),
            hub("complete_task", { delivered: true, key: "books-done", summary: "Written in the ledger" }),
          ].join("\n"),
          authority: OPENS,
        }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
    const rook = taskOf(tree, ROOK);

    const offeredToRook = offered(await run(firstPrompt(requests, rook)));
    expect(offeredToRook).toEqual(expect.arrayContaining(["shelf_read", "ledger_read", "ledger_write"]));
    expect(offeredToRook).not.toContain("shelf_write");
    // The lead's chat turn, whose reply a lost answer is settled on, offers both writes.
    expect(offered(requests[0] as PromptRequest)).toEqual(expect.arrayContaining(["shelf_write", "ledger_write"]));
    // Rook's Ledger write ran once on its Task; its Shelf write never reached the Charm, and its refusal is on Rook's Task.
    expect([...rows.values()].map((call) => [call.tool, call.scope, call.messageId])).toEqual([
      ["ledger_write", `task:${rook.id}`, null],
    ]);
    expect(tree.refusals).toEqual([
      expect.objectContaining({ agentId: ROOK, taskId: rook.id, tool: "shelf_write", reason: "unknown-tool" }),
    ]);
  }, 30_000);
});
