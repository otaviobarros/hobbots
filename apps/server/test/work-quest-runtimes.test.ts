import {
  HobbotsRepository,
  type HubToolAnswer,
  type HubTools,
  makeRedactor,
  PackReports,
  WorkQuests,
  WorkTools,
  WorkToolsLive,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  Channel,
  ChannelId,
  FINISH_WORK_TOOL,
  MemoryPath,
  Message,
  MessageId,
  type PackRead,
  roleFields,
  START_WORK_TOOL,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, WorkQuestRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `start_work` and `finish_work` on each runtime that serves hub tools (ADR 041): the fake runtime,
// and an installed Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each
// with a stand-in model. One turn starts a Quest in the camp's main line, and a second start in the
// same conversation is refused; the next turn finishes it, and the card reads it done. The Quest lists
// what Ada's session read first, from the report of the pack it started from (#1487).

const NOW = "2026-11-16T00:00:00.000Z";
const ADA = AgentId.make("ada");

const hub = ManagedRuntime.make(
  WorkToolsLive.pipe(
    Layer.provideMerge(Layer.mergeAll(WorkQuests.layer, PackReports.layer)),
    Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, WorkQuestRepositoryLive)),
    Layer.provideMerge(TestDatabase),
  ),
);

const reply = (channelId: ChannelId, id: string) =>
  new Message({
    id: MessageId.make(id),
    channelId,
    role: "assistant",
    content: "",
    status: "streaming",
    error: null,
    configVersion: 1 as Message["configVersion"],
    createdAt: NOW,
  });

/** A reply of Ada's being written in `channelId`, with the Quest tools its turn is offered. */
const turnIn = (channelId: ChannelId, id: string) =>
  hub.runPromise(
    Effect.gen(function* () {
      const message = reply(channelId, id);
      yield* (yield* HobbotsRepository).upsertMessage(message);
      const tools = yield* WorkTools.use((service) =>
        service.forTurn({
          agentId: ADA,
          channelId,
          messageId: message.id,
          runtime: "claude-code",
          scope: () => `reply:${message.id}`,
          currentAccess: Effect.succeed(null),
          redactor: makeRedactor([]),
          approvals: null,
        }),
      );
      if (tools === null) throw new Error("No Quest tools for a chat turn");
      // Every answer the hob read, in order.
      const answers: Array<HubToolAnswer> = [];
      const hubTools: HubTools = {
        tools: tools.tools,
        call: (name, input, step) =>
          Effect.tap(tools.call(name, input, step), (answer) => Effect.sync(() => answers.push(answer))),
      };
      return { messageId: message.id, hubTools, answers };
    }),
  );

/** What Ada's session read first in a camp: a memory page and a decision. */
const READ_FIRST: ReadonlyArray<PackRead> = [
  {
    _tag: "MemoryPage",
    scope: { _tag: "Hob", agentId: ADA },
    path: MemoryPath.make("shop/look.md"),
    title: "The shop's look",
  },
  { _tag: "Decision", id: "decision-1", title: "Sign-ups stop at 200", messageId: null },
];

const campOf = (name: string) =>
  hub.runPromise(
    Effect.gen(function* () {
      const channelId = ChannelId.make(`camp-${name}`);
      yield* (yield* HobbotsRepository).upsertChannel(
        new Channel({ id: channelId, ownerHobId: ADA, title: name, createdAt: NOW, updatedAt: NOW }),
      );
      // The pack Ada's Claude Code session started from in the camp, as its turn reported it, and
      // a later one her Codex session started from, which a switch back to Claude Code does not read.
      yield* PackReports.use((reports) =>
        Effect.andThen(
          reports.record(
            channelId,
            { hobId: ADA, runtime: "claude-code" },
            { budget: 12_000, tokens: 100, parts: [], read: READ_FIRST },
          ),
          reports.record(
            channelId,
            { hobId: ADA, runtime: "codex" },
            { budget: 12_000, tokens: 100, parts: [], read: READ_FIRST.slice(1) },
          ),
        ),
      );
      return channelId;
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

const START = {
  title: "Winter market page",
  goal: "A landing page for the winter market.",
  done_when: ["The page is live", "It shows the map"],
  expected_by: "2026-12-01",
};

/** Runs a turn on `runtime` that starts a Quest twice, then one that finishes it. */
const work = async (runtime: HubCallRuntime) => {
  const channelId = await campOf(runtime.name);
  const first = await turnIn(channelId, `start-${runtime.name}`);
  const started = await runtime.turn({
    hubTools: first.hubTools,
    recordToolStart: () => Effect.succeed(true),
    calls: [
      { tool: START_WORK_TOOL, input: START },
      { tool: START_WORK_TOOL, input: { ...START, title: "Another page" } },
    ],
  });
  expect(Exit.isSuccess(started.exit), String(started.exit)).toBe(true);
  const running = await hub.runPromise(WorkQuests.use((quests) => quests.of(channelId)));
  const second = await turnIn(channelId, `finish-${runtime.name}`);
  const finished = await runtime.turn({
    hubTools: second.hubTools,
    recordToolStart: () => Effect.succeed(true),
    calls: [{ tool: FINISH_WORK_TOOL, input: { result: "The page is live with the map.", made: ["PR #12"] } }],
  });
  expect(Exit.isSuccess(finished.exit), String(finished.exit)).toBe(true);
  const done = await hub.runPromise(WorkQuests.use((quests) => quests.of(channelId)));
  return { first, second, running, done };
};

describe("start_work and finish_work on every runtime", () => {
  // covers ADR 041 (Tools)
  it("each runtime starts a Quest where the hob talks, with what it read first, refuses a second, and finishes it (#1596, #1487)", {
    timeout: 240_000,
  }, async () => {
    expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
    for (const runtime of runtimes.runtimes) {
      const { first, second, running, done } = await work(runtime);
      expect(
        first.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([false, true]);
      expect(first.answers[1]?.text, runtime.name).toContain("busy");
      expect(
        running.map((quest) => ({
          title: quest.title,
          state: quest.state,
          startedFrom: quest.startedFrom,
          readFirst: quest.readFirst,
        })),
        runtime.name,
      ).toEqual([
        { title: "Winter market page", state: "active", startedFrom: first.messageId, readFirst: READ_FIRST },
      ]);
      expect(
        second.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([false]);
      expect(
        done.map((quest) => ({
          state: quest.state,
          ownerHobId: quest.ownerHobId,
          doneWhen: quest.doneWhen,
          expectedBy: quest.expectedBy,
          result: quest.result,
          made: quest.made,
          finishedFrom: quest.finishedFrom,
        })),
        runtime.name,
      ).toEqual([
        {
          state: "done",
          ownerHobId: ADA,
          doneWhen: ["The page is live", "It shows the map"],
          expectedBy: "2026-12-01",
          result: "The page is live with the map.",
          made: ["PR #12"],
          finishedFrom: second.messageId,
        },
      ]);
    }
  });
});
