import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptRequest } from "@hobbots/agents";
import { CONTINUATION_HEADER, type RuntimeKind, type TaskTree } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1555: a criterion's id reached its lead only in start_quest's result, and in read_tasks of
// the Quest's own Task. A session never sees an earlier session's tool results, so a lead in a new
// one (a new Codex thread since #1543, a new chapter, a brain switch, a compacted session) could not
// name a criterion to check_criterion. Its briefing now lists them from the records, and read_tasks
// of any Task under the Quest shows them.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

const isLeadsFirst = (request: PromptRequest) => request.prompt.startsWith("Write the launch page");
const isWake = (request: PromptRequest) => request.prompt.startsWith(CONTINUATION_HEADER);
const done = (tree: TaskTree) => tree.tasks[0]?.state === "completed";

/** What the briefing says of the Task, without the context pack, which carries what was said before. */
const taskPart = (briefing: string | null | undefined) => {
  const text = briefing ?? "";
  const at = text.indexOf("You are working on Task");
  return at === -1 ? "" : text.slice(at);
};

describe.each(RUNTIMES)("a Quest lead's criterion ids, on %s", (runtime) => {
  // covers OR-004, OR-006, RT-001
  it("[TC-OR-1555-01] reach a lead in a new session from its briefing, and read_tasks of a member's Task shows them", async () => {
    // Frodo's first turn runs without the newer Task tools, so on Codex his wake starts a new thread (#1543).
    const party = partyHub({
      lead: runtime,
      members: runtime,
      files: true,
      withholds: (request) => (isLeadsFirst(request) ? ["check_criterion"] : []),
    });
    dispose = party.dispose;
    writeFileSync(join(party.project, "index.html"), "<h1>Launch on Friday 6 December</h1>\n");
    party.reactions.push({
      on: CONTINUATION_HEADER,
      lines: [
        hub("read_tasks", { key: "read-member", task_id: "$page.task_id" }),
        hub("check_criterion", {
          key: "accept",
          criterion_id: "$quest.criteria.0.criterion_id",
          verdict: "accepted",
          reason: "It says Friday 6 December",
          evidence: ["$pip-done.artifacts.0"],
        }),
        hub("complete_task", { key: "whole", delivered: true, summary: "The page is written" }),
      ],
    });
    await party.run(
      send([
        "Write the launch page",
        hub("start_quest", {
          key: "quest",
          goal: "Write the launch page",
          acceptance: ["The page names the launch date", { text: "The page has a photo", optional: true }],
        }),
        hub("delegate_task", {
          key: "page",
          hob: "Pip",
          brief: [
            "Write the launch page",
            hub("complete_task", {
              key: "pip-done",
              summary: "The page is written",
              artifacts: [{ kind: "file", label: "Launch page", value: "index.html" }],
            }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
      ]),
    );
    const finished = await party.run(treeWhen(done));
    const [quest] = finished.quests;
    const [date, photo] = quest?.criteria ?? [];
    if (date === undefined || photo === undefined) throw new Error("the Quest has no criteria");
    const wake = party.requests.find(isWake);

    if (runtime === "codex") expect(wake?.sessionId).toBeNull();
    // The briefing names each criterion by its id, from the records, whatever the session was told before.
    const briefed = taskPart(wake?.briefing);
    expect(briefed).toContain(`- criterion_id ${date.id}: "The page names the launch date" (required, open)`);
    expect(briefed).toContain(`- criterion_id ${photo.id}: "The page has a photo" (optional, open)`);
    expect(party.answers.get("read-member")).toContain(`"criterion_id":"${date.id}"`);
    expect(party.answers.get("accept")).toContain("is accepted");
    expect(quest?.state).toBe("completed");
  }, 30_000);
});
