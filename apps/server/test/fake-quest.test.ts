import { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import { Agent, AgentId, Message, MessageId, type Task, type TaskTree, Thread, ThreadId } from "@hobbots/domain";
import { BackpackLive, EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Duration, Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { FakeQuestLive } from "../src/fake-quest.ts";

// The fake Black Friday Quest the browser tests follow (ADR 018): cancelling one member's Task
// stops only that Task, and the play goes on with the rest of the Quest.

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const threadId = ThreadId.make("black-friday-thread");

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Marketing",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const each of [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(ADA, "Ada")]) yield* repo.insertAgent(each);
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: ALDRIC, title: "Black Friday", createdAt: now, updatedAt: now }),
    );
  }),
);

const App = FakeQuestLive(Duration.millis(40)).pipe(
  Layer.provideMerge(Party),
  Layer.provideMerge(
    Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, BackpackLive, EventJournal.layer, EventBus.layer),
  ),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

/** The thread's Task tree, once the play has started it. */
const treeNow = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  return (yield* tasks.readThreadTrees(threadId))[0];
});

const named = (tree: TaskTree | undefined, brief: string): Task | undefined =>
  tree?.tasks.find((task) => task.brief.startsWith(brief));

/** Looks again every 20 ms until `found` gives a value, for at most ten seconds. */
const until = <A>(found: Effect.Effect<A | undefined, never, Layer.Success<typeof App>>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries++) {
      const value = yield* found;
      if (value !== undefined) return value;
      yield* Effect.sleep(Duration.millis(20));
    }
    return yield* Effect.die(new Error("Timed out"));
  });

describe("FakeQuestLive", () => {
  it("[TC-OR-166] cancelling Ada's Task before Quill finishes stops only Ada's, and Quill's copy still completes", async () => {
    runtime = ManagedRuntime.make(App);
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const tasks = yield* TaskRepository;
        const bus = yield* EventBus;
        const asked = yield* repo.upsertMessage(
          new Message({
            id: MessageId.make("request"),
            threadId,
            role: "user",
            content: "Plan a Black Friday campaign for the shop",
            status: "complete",
            error: null,
            configVersion: null,
            createdAt: now,
          }),
        );
        // The play listens from a fiber of its own; give it a moment to start listening.
        yield* Effect.sleep(Duration.millis(100));
        yield* bus.publish(asked.entries);

        // Ada's Task waits on Quill's copy; you cancel it as the Quest tab would.
        const build = yield* until(
          Effect.map(treeNow, (tree) => {
            const found = named(tree, "Build the campaign");
            return found?.state === "waiting" ? found : undefined;
          }),
        );
        expect(named(yield* treeNow, "Draft the landing copy")?.state).toBe("active");
        const cancelling = yield* tasks.moveTask(build.id, build.revision, "cancelling", now);
        yield* bus.publish(cancelling.entries);

        // Ada's session stops, and her Task can be confirmed cancelled.
        const stopped = yield* until(
          Effect.map(treeNow, (tree) => {
            const attempt = tree?.attempts.find((each) => each.taskId === build.id);
            return attempt?.state === "cancelled" ? attempt : undefined;
          }),
        );
        expect(stopped.outcome).toBe("Stopped when you cancelled it.");
        const latest = Option.getOrThrow(yield* tasks.readTree(build.id)).tasks[0];
        if (latest === undefined) throw new Error("No Task for Ada");
        yield* bus.publish((yield* tasks.moveTask(build.id, latest.revision, "cancelled", now)).entries);

        // The play goes on: Quill finishes the copy, and Ada's Task is never touched again.
        const copy = yield* until(
          Effect.map(treeNow, (tree) => {
            const found = named(tree, "Draft the landing copy");
            return found?.state === "completed" ? found : undefined;
          }),
        );
        const tree = yield* treeNow;
        expect(copy.result?.summary).toBe("Landing copy ready");
        expect(named(tree, "Build the campaign")?.state).toBe("cancelled");
        expect(tree?.questions.some((question) => question.taskId === build.id)).toBe(false);
        expect(tree?.handOffs).toEqual([]);
      }),
    );
  }, 20_000);
});
