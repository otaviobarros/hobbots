import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskRepository } from "@hobbots/agents";
import { DeviceId, OWNER_ACTOR, type TaskTree } from "@hobbots/domain";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { hub, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #1445 on each runtime that serves hub tools (STD-TEST-002): the fake runtime, and an
// installed Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each with a
// stand-in model that makes the calls a turn's prompt scripts. Every turn of the lead and its members
// runs on that runtime, through its own MCP or dynamic tools: start_quest with a criterion given as an
// object, check_criterion on evidence, the version that voids it, and a waiver only your answer gives.

const DATE = "$quest.criteria.0.criterion_id";
const PHOTO = "$quest.criteria.1.criterion_id";

const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

let runtimes: Awaited<ReturnType<typeof hubCallRuntimes>>;
beforeAll(async () => {
  runtimes = await hubCallRuntimes();
});
afterAll(() => runtimes.close());

/** A member's brief that returns the page, by its path inside the hob's folder, under `key`. */
const returnsPage = (brief: string, key: string) =>
  [
    brief,
    hub("complete_task", {
      key,
      summary: "The page is written",
      artifacts: [{ kind: "file", label: "Launch page", value: "index.html" }],
    }),
  ].join("\n");

/** A line for the lead's `turn`th turn after the first. */
const on = (turn: number, tool: string, input: object) => `${"fake:then ".repeat(turn)}${hub(tool, input)}`;

const done = (tree: TaskTree) => tree.tasks[0]?.state === "completed";

/** The whole Quest, played on `runtime`: on the fake, the hub's own fake runtime plays it. */
const quest = async (runtime: HubCallRuntime) => {
  const kind = runtime.name === "fake" ? "claude-code" : runtime.name;
  const party = partyHub({
    lead: kind,
    members: kind,
    files: true,
    ...(runtime.name === "fake" ? {} : { turnsOn: runtime }),
  });
  try {
    const { run, answers, project } = party;
    writeFileSync(join(project, "index.html"), "<h1>Launch on Friday 6 December</h1>\n");
    await run(
      send([
        "Write the launch page",
        hub("start_quest", {
          key: "quest",
          goal: "Write the launch page",
          acceptance: ["The page names the launch date", { text: "The page has a photo", optional: true }],
        }),
        hub("delegate_task", { key: "page", hob: "Pip", brief: returnsPage("Write the launch page", "pip-done") }),
        hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
        // Pip's result: Frodo cannot finish yet, accepts the date on Pip's page and waives the photo.
        on(1, "complete_task", { key: "early", delivered: true, summary: "The page is written" }),
        on(1, "check_criterion", {
          key: "accept",
          criterion_id: DATE,
          verdict: "accepted",
          reason: "It says Friday 6 December",
          evidence: ["$pip-done.artifacts.0"],
        }),
        on(1, "check_criterion", { key: "photo", criterion_id: PHOTO, verdict: "waived", reason: "No photo" }),
        on(1, "delegate_task", { key: "polish", hob: "Quill", brief: returnsPage("Polish the page", "quill-done") }),
        on(1, "wait_for", { key: "wait-polish", tasks: ["$polish.task_id"] }),
        // Quill's page is version 2, which voids the evidence: Frodo's waiver asks you instead.
        on(2, "complete_task", { key: "voided", delivered: true, summary: "The page is written" }),
        on(2, "check_criterion", {
          key: "waive",
          criterion_id: DATE,
          verdict: "waived",
          reason: "The date is not set yet",
        }),
        // Your "Waive it" wakes him, and the Quest completes.
        on(3, "complete_task", { key: "whole", delivered: true, summary: "The page is written, without a date" }),
      ]),
    );
    const asked = await run(treeWhen((tree) => tree.questions.some((question) => question.state === "open")));
    const question = asked.questions.find((each) => each.state === "open");
    if (question === undefined) throw new Error("no open question");
    await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const bus = yield* EventBus;
        // From your session on your phone: the waiver you choose names you.
        const from = { deviceId: DeviceId.make("phone"), via: "chat", actor: OWNER_ACTOR } as const;
        const answered = yield* tasks.answerQuestion(
          question.id,
          { _tag: "User" },
          "Waive it",
          new Date().toISOString(),
          from,
        );
        yield* bus.publish(answered.entries);
      }),
    );
    const finished = await run(treeWhen(done));
    return { answers, question, finished };
  } finally {
    await party.dispose();
  }
};

describe("a Quest's acceptance criteria on every runtime", () => {
  // covers OR-004, OR-006, IN-004, EX-002
  it("[TC-OR-1445-08] each runtime's turns accept a criterion on evidence, void it with a newer version, and waive it only by your answer", {
    timeout: 600_000,
  }, async () => {
    expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
    for (const runtime of runtimes.runtimes) {
      const before = runtime.modelText().length;
      const { answers, question, finished } = await quest(runtime);
      // The runtime's model read what the hub answered, through the runtime's own tool calls.
      const read = runtime.modelText().slice(before).join("\n");
      if (runtime.name !== "fake") {
        expect(read, runtime.name).toContain("Its acceptance criteria have ids");
        expect(read, runtime.name).toContain("only the user waives it: the hub asked them");
      }
      const said = (key: string) => answers.get(key) ?? `${runtime.name}: no answer to ${key}`;
      expect(said("quest"), runtime.name).toContain("Its acceptance criteria have ids");
      expect(said("early"), runtime.name).toContain("Refused (criteria-unmet)");
      expect(said("accept"), runtime.name).toContain('is accepted on "Launch page" version 1');
      expect(said("photo"), runtime.name).toContain("is waived by you");
      expect(said("voided"), runtime.name).toContain("its evidence was voided by a newer version");
      expect(said("waive"), runtime.name).toContain("only the user waives it: the hub asked them");
      expect(question, runtime.name).toMatchObject({
        recipientId: null,
        text: 'Waive "The page names the launch date"? The date is not set yet',
        options: [{ label: "Waive it" }, { label: "Keep it" }],
      });
      const [whole] = finished.quests;
      expect(whole?.state, runtime.name).toBe("completed");
      expect(whole?.criteria[0], runtime.name).toMatchObject({
        state: "waived",
        waiverAsk: null,
        decided: { by: OWNER_ACTOR, reason: "The date is not set yet" },
        evidence: [{ version: 1, taskId: ownedBy(finished, PIP)?.id, voidedAt: expect.any(String) }],
      });
      expect(whole?.criteria[1], runtime.name).toMatchObject({ state: "waived", decided: { by: { kind: "hob" } } });
      expect(ownedBy(finished, QUILL)?.state, runtime.name).toBe("completed");
    }
  });
});
