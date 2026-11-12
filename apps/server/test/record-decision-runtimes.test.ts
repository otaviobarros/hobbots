import {
  HobbotsRepository,
  type HubToolAnswer,
  type HubTools,
  makeRedactor,
  Records,
  RecordTools,
  RecordToolsLive,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  DECISION_TEXT_MAX,
  DecisionStates,
  Message,
  MessageId,
  RECORD_DECISION_TOOL,
  roleFields,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, RecordRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `record_decision` on each runtime that serves hub tools (ADR 037, Records): the fake runtime, and
// an installed Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each with
// a stand-in model. A call records the decision in the reply's chat, by the hob, from the reply, and
// one over the limit is refused with nothing recorded.

const NOW = "2026-11-12T00:00:00.000Z";
const ADA = AgentId.make("ada");

const hub = ManagedRuntime.make(
  RecordToolsLive.pipe(
    Layer.provideMerge(Records.layer),
    Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, RecordRepositoryLive)),
    Layer.provideMerge(TestDatabase),
  ),
);

/** A camp of Ada's with a reply being written in it, as a turn's hub tools see it. */
const camp = (id: string) =>
  hub.runPromise(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const threadId = ThreadId.make(`camp-${id}`);
      const messageId = MessageId.make(`reply-${id}`);
      yield* repo.upsertThread(new Thread({ id: threadId, agentId: ADA, title: id, createdAt: NOW, updatedAt: NOW }));
      yield* repo.upsertMessage(
        new Message({
          id: messageId,
          threadId,
          role: "assistant",
          content: "",
          status: "streaming",
          error: null,
          configVersion: 1 as Message["configVersion"],
          createdAt: NOW,
        }),
      );
      const tools = yield* RecordTools.use((service) =>
        service.forTurn({
          agentId: ADA,
          threadId,
          messageId,
          scope: () => `reply:${messageId}`,
          currentAccess: Effect.succeed(null),
          redactor: makeRedactor([]),
          approvals: null,
        }),
      );
      if (tools === null) throw new Error("No record tools for a chat turn");
      // Every answer the hob read, in order.
      const answers: Array<HubToolAnswer> = [];
      const hubTools: HubTools = {
        tools: tools.tools,
        call: (name, input, step) =>
          Effect.tap(tools.call(name, input, step), (answer) => Effect.sync(() => answers.push(answer))),
      };
      return { threadId, messageId, hubTools, answers };
    }),
  );

const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

let runtimes: Awaited<ReturnType<typeof hubCallRuntimes>>;
beforeAll(async () => {
  runtimes = await hubCallRuntimes();
  await hub.runPromise(
    Effect.flatMap(HobbotsRepository, (repo) =>
      repo.insertAgent(
        new Agent({
          id: ADA,
          name: "Ada",
          ...roleFields("writer"),
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 1,
          lookColor: "moss",
          configVersion: 1,
          createdAt: NOW,
        }),
      ),
    ),
  );
});
afterAll(async () => {
  runtimes.close();
  await hub.dispose();
});

/** Runs a turn on `runtime` that records one decision and tries one over the limit. */
const decide = async (runtime: HubCallRuntime) => {
  const turn = await camp(runtime.name);
  const { exit } = await runtime.turn({
    hubTools: turn.hubTools,
    recordToolStart: () => Effect.succeed(true),
    calls: [
      { tool: RECORD_DECISION_TOOL, input: { key: "tuesdays", text: "Launch emails go out on Tuesdays." } },
      { tool: RECORD_DECISION_TOOL, input: { key: "long", text: "x".repeat(DECISION_TEXT_MAX + 1) } },
    ],
  });
  expect(Exit.isSuccess(exit), String(exit)).toBe(true);
  const decisions = await hub.runPromise(Records.use((records) => records.decisionsOf(turn.threadId)));
  return { ...turn, decisions };
};

describe("record_decision on every runtime", () => {
  // covers CH-001, ADR 037 (Records)
  it("[TC-CH-1383-07] each runtime records a decision by the hob from its reply, and refuses one over the limit", {
    timeout: 240_000,
  }, async () => {
    expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
    for (const runtime of runtimes.runtimes) {
      const result = await decide(runtime);
      expect(
        result.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([false, true]);
      expect(result.answers[1]?.text, runtime.name).toContain("too-long");
      expect(
        result.decisions.map((decision) => ({
          text: decision.text,
          actor: decision.actor,
          sourceMessageId: decision.sourceMessageId,
          active: DecisionStates.isActive(decision),
        })),
        runtime.name,
      ).toEqual([
        {
          text: "Launch emails go out on Tuesdays.",
          actor: { kind: "hob", id: ADA },
          sourceMessageId: result.messageId,
          active: true,
        },
      ]);
    }
  });
});
