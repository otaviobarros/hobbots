import { ChapterRepository, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type ChapterId,
  Message,
  MessageId,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import {
  BackpackLive,
  ChapterRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { FakeQuestLive } from "../src/fake-quest.ts";

// The fake Black Friday Quest the browser tests follow (ADR 018): cancelling one member's Task
// stops only that Task, and the play goes on with the rest of the Quest. A chapter moved into a
// camp while the Quest runs takes it there, and the play's next messages land in the camp (#1389).

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
      new Thread({
        id: threadId,
        agentId: ALDRIC,
        title: "Black Friday",
        kind: "chat",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }),
);

const App = FakeQuestLive(Duration.millis(40)).pipe(
  Layer.provideMerge(Party),
  Layer.provideMerge(
    Layer.mergeAll(
      HobbotsRepositoryLive,
      TaskRepositoryLive,
      ChapterRepositoryLive,
      BackpackLive,
      EventJournal.layer,
      EventBus.layer,
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

/** The thread's Task tree, once the play has started it. */
const treeIn = (thread: ThreadId) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    return (yield* tasks.readThreadTrees(thread))[0];
  });
const treeNow = treeIn(threadId);

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

/** Asks Aldric for the Black Friday campaign in the chat, as the browser does. */
const askForCampaign = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
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
});

describe("FakeQuestLive", () => {
  // covers CH-009, OR-001, ADR 037 (Quests in camps)
  it("[TC-CH-1389-04] a Quest whose chapter moves into a camp while it runs goes on there, and its lead's next messages land in the camp", async () => {
    runtime = ManagedRuntime.make(App);
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const chapters = yield* ChapterRepository;
        const tasks = yield* TaskRepository;
        const bus = yield* EventBus;
        yield* askForCampaign;
        // Quill is at the copy: the Quest runs. You move the chat's chapter, which started it, into a camp.
        yield* until(Effect.map(treeNow, (tree) => named(tree, "Draft the landing copy")));
        const [chapter] = yield* chapters.listChapters(threadId);
        const camp = ThreadId.make("black-friday-camp");
        const moved = yield* repo.moveChapter({
          threadId,
          chapterId: (chapter as { readonly id: ChapterId }).id,
          target: {
            _tag: "new",
            camp: new Thread({
              id: camp,
              agentId: ALDRIC,
              title: "Black Friday",
              kind: "camp",
              goal: "Run the campaign",
              origin: { threadId, chapterId: null },
              createdAt: now,
              updatedAt: now,
            }),
          },
          at: now,
        });
        yield* bus.publish(moved.entries);

        // Ada's question climbs to you, and the lead says so in the camp; you answer it there.
        const question = yield* until(
          Effect.map(treeIn(camp), (tree) => tree?.questions.find((each) => each.recipientId === null)),
        );
        yield* until(
          Effect.map(repo.listMessages(camp), (all) => all.find((m) => m.content.includes("one question for you"))),
        );
        yield* bus.publish(
          (yield* tasks.answerQuestion(question.id, { _tag: "User" }, "Dec 12 for international", now)).entries,
        );
        // The lead wraps up in the camp, and nothing of the Quest is left in the chat.
        yield* until(
          Effect.map(repo.listMessages(camp), (all) => all.find((m) => m.content.includes("campaign is ready"))),
        );
        expect((yield* treeIn(camp))?.tasks[0]?.state).toBe("completed");
        expect(yield* treeNow).toBeUndefined();
        expect((yield* repo.listMessages(threadId)).map((m) => m.content)).toEqual([]);
      }),
    );
  }, 20_000);

  it("[TC-OR-166] cancelling Ada's Task before Quill finishes cancels only Ada's, and Quill's copy still completes", async () => {
    runtime = ManagedRuntime.make(App);
    await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const bus = yield* EventBus;
        yield* askForCampaign;

        // Ada's Task waits, queued, on Quill's copy; you cancel it as the Quest tab would. Nothing
        // of hers runs yet, so the cancel is confirmed at once.
        const build = yield* until(
          Effect.map(treeNow, (tree) => {
            const found = named(tree, "Build the campaign");
            return found?.state === "queued" ? found : undefined;
          }),
        );
        expect(named(yield* treeNow, "Draft the landing copy")?.state).toBe("active");
        yield* bus.publish((yield* tasks.moveTask(build.id, build.revision, "cancelled", now)).entries);

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
