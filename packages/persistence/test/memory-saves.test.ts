import { HobbotsRepository, MemorySaves } from "@hobbots/agents";
import { Agent, AgentId, MemoryPath, MemorySave, MemoryVersion, MessageId, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, MemorySavesLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, MemorySavesLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | MemorySaves | EventJournal | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-05T00:00:00.000Z";
const later = "2026-11-05T00:05:00.000Z";
const pip = AgentId.make("pip");

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: pip,
      name: "Pip",
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
});

const save = (key: string, overrides: Partial<MemorySave> = {}) =>
  new MemorySave({
    id: `${key}-id`,
    agentId: pip,
    work: "reply:m1",
    key,
    input: `{"path":"notes/tests.md","scope":"mine"}`,
    scope: { _tag: "Hob", agentId: pip },
    path: MemoryPath.make("notes/tests.md"),
    markdown: "# Tests\n\nRun `pnpm test`.",
    tags: ["tests"],
    state: "sending",
    version: null,
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

describe("memory save records", () => {
  // covers ADR 028 (The memory tools, When memory is down)
  it("[TC-GEN-240] records and journals a save once per key, and returns it for the same key", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const saves = yield* MemorySaves;
        const journal = yield* EventJournal;
        const started = yield* saves.begin(save("tests"));
        expect(started._tag).toBe("Started");
        if (started._tag !== "Started") return;
        expect(started.entries.map((entry) => entry.type)).toEqual(["MemorySaveRecorded"]);
        expect(started.entries[0]?.correlation).toMatchObject({ agentId: pip, threadId: "t1", messageId: "m1" });
        // A retry, with a fresh id, finds the first save: nothing new is recorded or journaled.
        const again = yield* saves.begin(save("tests", { id: "another" }));
        expect(again).toMatchObject({ _tag: "Existing", save: { id: "tests-id", state: "sending" } });
        // The reply's scope is looked in too, as a chat turn's retry after it started its Task does.
        const moved = yield* saves.begin(save("tests", { id: "moved", work: "task:k1" }), "reply:m1");
        expect(moved._tag).toBe("Existing");
        // The same key is free in other work.
        expect((yield* saves.begin(save("tests", { id: "other", work: "task:k2" })))._tag).toBe("Started");
        const types = (yield* journal.readAfter(0)).map((entry) => entry.type);
        expect(types.filter((type) => type === "MemorySaveRecorded")).toHaveLength(2);
      }),
    ));

  it("[TC-GEN-241] settles a save once, keeps a queued save to send, and lists what is unsent", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const saves = yield* MemorySaves;
        yield* saves.begin(save("kept"));
        yield* saves.begin(save("done", { id: "done-id", createdAt: later, updatedAt: later }));
        const queued = yield* saves.settle(save("kept"), "queued", null, later);
        expect(Option.getOrThrow(queued).value.state).toBe("queued");
        expect(Option.getOrThrow(queued).entries.map((entry) => entry.type)).toEqual(["MemorySaveChanged"]);
        // Both a queued save and one still sending are unsent, oldest first.
        expect((yield* saves.unsent).map((s) => s.key)).toEqual(["kept", "done"]);
        const version = MemoryVersion.make("v1");
        const saved = yield* saves.settle(save("done", { id: "done-id" }), "saved", version, later);
        expect(Option.getOrThrow(saved).value).toMatchObject({ state: "saved", version: "v1" });
        // A late outcome never overwrites a settled save.
        expect(Option.isNone(yield* saves.settle(save("done", { id: "done-id" }), "queued", null, later))).toBe(true);
        // The capture worker sends the queued one later and settles it.
        expect(Option.isSome(yield* saves.settle(save("kept"), "saved", version, later))).toBe(true);
        expect(yield* saves.unsent).toEqual([]);
      }),
    ));

  it("[TC-GEN-242] refuses a state the record does not know", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const saves = yield* MemorySaves;
        yield* saves.begin(save("tests"));
        const failed = yield* Effect.exit(sql`UPDATE memory_saves SET state = 'lost'`);
        expect(failed._tag).toBe("Failure");
      }),
    ));

  // covers ADR 028 (In the chat), #961
  it("[TC-GEN-346] finds a save, lists a thread's saves, and marks a saved one undone once", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const saves = yield* MemorySaves;
        yield* saves.begin(save("first"));
        yield* saves.begin(save("second", { id: "second-id", createdAt: later, updatedAt: later }));
        yield* saves.begin(save("elsewhere", { id: "elsewhere-id", threadId: ThreadId.make("t2") }));
        expect((yield* saves.inThread(ThreadId.make("t1"))).map((s) => s.id)).toEqual(["first-id", "second-id"]);
        expect(yield* saves.find("nothing")).toBeNull();

        // Only a saved save can be undone, and only once.
        expect(Option.isNone(yield* saves.markUndone("first-id", later))).toBe(true);
        yield* saves.settle(save("first"), "saved", MemoryVersion.make("v1"), later);
        const undone = Option.getOrThrow(yield* saves.markUndone("first-id", later));
        expect(undone.value).toMatchObject({ state: "saved", undoneAt: later });
        expect(undone.entries.map((entry) => entry.type)).toEqual(["MemorySaveChanged"]);
        expect(Option.isNone(yield* saves.markUndone("first-id", later))).toBe(true);
        expect(yield* saves.find("first-id")).toMatchObject({ undoneAt: later });
        expect((yield* saves.find("second-id"))?.undoneAt).toBeUndefined();
      }),
    ));
});
