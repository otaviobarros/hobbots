import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HobbotsRepository, type PromptRequest } from "@hobbots/agents";
import { CONTINUATION_HEADER, liveSession, type RuntimeKind, type TaskTree } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, partyHub, send, threadId, treeWhen } from "./party-hub.ts";

// Issue #1543: Codex keeps the hub tools a thread started with (ADR 024), and the hub resumed a
// hob's Codex thread on every turn of the chapter. A Quest lead whose thread started before
// `check_criterion` existed could start a Quest with criteria but never accept one, so it asked you
// to waive them. A session that lacks a Task tool the turn offers is no longer resumed on a runtime
// that keeps its first tools: the turn starts a new one from the context pack. Fake Codex keeps its
// first tools as Codex does; Claude Code is offered each turn's tools, so its session is resumed.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

/** The Task tools #1445 and #1446 added, which a lead's thread from before them never held. */
const NEWER_TOOLS = ["check_criterion", "retry_task", "reassign_task"];

const DATE = "$quest.criteria.0.criterion_id";

const done = (tree: TaskTree) => tree.tasks[0]?.state === "completed";

const isLeadsFirst = (request: PromptRequest) => request.prompt.startsWith("Write the launch page");
const isWake = (request: PromptRequest) => request.prompt.startsWith(CONTINUATION_HEADER);

/**
 * Frodo starts a Quest whose required criterion Pip's page proves, and waits for Pip. Pip's result
 * wakes him: he accepts the criterion on the page and completes the Quest.
 */
const questOn = async (runtime: RuntimeKind, withholds?: (request: PromptRequest) => ReadonlyArray<string>) => {
  const party = partyHub({ lead: runtime, members: runtime, files: true, ...(withholds ? { withholds } : {}) });
  dispose = party.dispose;
  writeFileSync(join(party.project, "index.html"), "<h1>Launch on Friday 6 December</h1>\n");
  party.reactions.push({
    on: CONTINUATION_HEADER,
    lines: [
      hub("check_criterion", {
        key: "accept",
        criterion_id: DATE,
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
        acceptance: ["The page names the launch date"],
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
  const first = party.requests.find(isLeadsFirst);
  const wake = party.requests.find(isWake);
  if (first === undefined || wake === undefined) throw new Error("Frodo's turns were not both asked");
  const session = await party.run(
    HobbotsRepository.use((repo) => repo.findThread(threadId)).pipe(
      Effect.map((thread) => liveSession(Option.getOrThrow(thread), runtime, FRODO)),
    ),
  );
  return { finished, first, wake, session, answers: party.answers };
};

describe.each(RUNTIMES)("a Quest lead's Task tools, on %s", (runtime) => {
  it("reach a lead whose session started before check_criterion existed, so it accepts the criterion and the Quest completes (#1543)", async () => {
    // Frodo's first turn runs as on a hub from before #1445 and #1446.
    const { finished, wake, session, answers } = await questOn(runtime, (request) =>
      isLeadsFirst(request) ? NEWER_TOOLS : [],
    );

    expect(wake.hubTools?.tools.map((tool) => tool.name)).toContain("check_criterion");
    if (runtime === "codex") {
      // Codex would keep the thread's first tools: the wake starts a new thread, which holds them.
      expect(wake.sessionId).toBeNull();
      expect(session?.taskTools).toEqual(expect.arrayContaining(["check_criterion", ...NEWER_TOOLS]));
    } else {
      // Claude Code is offered each turn's tools, so its session goes on.
      expect(wake.sessionId).not.toBeNull();
    }
    expect(answers.get("accept")).toContain('is accepted on "Launch page" version 1');
    expect(answers.get("whole")).not.toContain("Refused");
    const [quest] = finished.quests;
    expect(quest?.state).toBe("completed");
    expect(quest?.criteria.map((each) => [each.state, each.decided?.by.kind])).toEqual([["accepted", "hob"]]);
  }, 30_000);

  it("resume a lead's session that holds every Task tool (#1543)", async () => {
    const { finished, first, wake } = await questOn(runtime);

    expect(first.sessionId).toBeNull();
    expect(wake.sessionId).not.toBeNull();
    expect(finished.quests[0]?.state).toBe("completed");
  }, 30_000);
});
