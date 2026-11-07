import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CharmCalls, type ChatTaskTurn, HobbotsRepository, HobTools, TaskRepository } from "@hobbots/agents";
import { Agent, AgentId, CharmCall, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { TaskTools } from "@hobbots/orchestration";
import {
  BackpackLive,
  CharmCallsLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// #660 at hub level: the calls a chat turn makes before and as it starts its Task belong to that
// Task's work, so a later reply on the Task finds them, a Charm write included. Against a real
// database: SQLite here, and PostgreSQL under `pnpm test:pg` (STD-TEST-006).

const now = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const threadId = ThreadId.make("t1");

let work: string;

const TestHobTools = Layer.sync(HobTools, () =>
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [],
          hob: agent.policy,
          dataFolder: join(work, "data"),
          restrictions: [],
        },
        folders: [work],
        runtimeFolder: join(work, "runtimes", agent.id),
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
      }),
  }),
);

const App = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        CharmCallsLive,
        BackpackLive,
        EventJournal.layer,
      ).pipe(Layer.provideMerge(TestDatabase)),
      EventBus.layer,
      NodeFolderChecks,
      TestHobTools,
      FakeRuntimeLayer(),
    ),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-call-key-scopes-")));
  runtime = ManagedRuntime.make(App);
});

afterEach(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof App>>) => runtime.runPromise(effect);

/** Frodo, in a thread where he works on no Task yet. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: FRODO,
      name: "Frodo",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    }),
  );
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "Quest", createdAt: now, updatedAt: now }),
  );
});

const chatTurn = (message: string) =>
  run(
    Effect.flatMap(Effect.service(TaskTools), (tools) =>
      tools.forChat({
        agentId: FRODO,
        threadId,
        messageId: MessageId.make(message),
        prompt: "Start the Quest",
        runtime: "claude-code",
        configVersion: 1,
      }),
    ),
  );

const answer = (turn: ChatTaskTurn, name: string, input: object) => run(turn.hubTools.call(name, input));

/** A GitHub comment the turn sent and GitHub applied, under the turn's scope as a Charm write records it. */
const comment = (turn: ChatTaskTurn, message: string) =>
  run(
    Effect.gen(function* () {
      const calls = yield* CharmCalls;
      const call = new CharmCall({
        agentId: FRODO,
        scope: turn.scope(),
        key: "comment-1",
        attempt: `${message}-1`,
        charm: "GitHub",
        tool: "github_comment",
        input: '{"body":"Started"}',
        site: "github.com/octo/app issues/1",
        plan: "{}",
        appliedText: "Commented.",
        state: "sending",
        result: null,
        threadId,
        messageId: MessageId.make(message),
        stepId: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* calls.begin(call);
      yield* calls.settle(call, "applied", "Commented.", now);
    }),
  );

describe("tool call keys across a Task's replies", () => {
  // covers OR-001, EX-001, EX-003
  it("[TC-OR-425] a later reply on a Task finds the calls its first reply made, a Charm write included, and replays them", async () => {
    await run(seed);
    const first = await chatTurn("reply-1");
    // Before the Task starts, Frodo comments on GitHub; then he starts the Quest and reports.
    await comment(first, "reply-1");
    const started = await answer(first, "start_quest", { key: "quest", goal: "Ship the badge" });
    expect(started.refused).toBe(false);
    const report = { key: "cp-progress-1", kind: "progress", summary: "Under way" };
    const reported = await answer(first, "report_checkpoint", report);
    expect(reported.refused).toBe(false);

    // A later reply on the same Task: each retry returns its first result and does nothing again.
    const second = await chatTurn("reply-2");
    expect(second.scope()).toMatch(/^task:/);
    expect(await answer(second, "start_quest", { key: "quest", goal: "Ship the badge" })).toEqual(started);
    expect(await answer(second, "report_checkpoint", report)).toEqual(reported);
    const found = await run(
      Effect.flatMap(Effect.service(CharmCalls), (calls) => calls.find(FRODO, [second.scope()], "comment-1")),
    );
    expect(Option.getOrThrow(found)).toMatchObject({ state: "applied", result: "Commented." });

    // The same key for another call on the Task is still refused.
    const other = await answer(second, "report_checkpoint", { ...report, summary: "Something else" });
    expect(other).toMatchObject({ refused: true, text: expect.stringContaining("key-reused") });

    const trees = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    expect(trees).toHaveLength(1);
    expect(trees[0]?.checkpoints.filter((each) => each.summary === "Under way")).toHaveLength(1);
  });
});
