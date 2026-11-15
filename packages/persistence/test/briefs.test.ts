import { BriefLog, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import { Agent, AgentId, type BriefDraft, roleFields, TaskId, Channel, ChannelId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { BriefLogLive, EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1384 (ADR 037, Records): the brief projector's store. A brief is written with its
// `BriefWritten` and the cursor in one transaction, only when its rule lets it through, so a
// replayed page writes nothing twice and a failed brain leaves the last brief in place. On SQLite
// and PostgreSQL alike.

const NOW = "2026-11-12T00:00:00.000Z";
const LATER = "2026-11-12T01:00:00.000Z";
const ADA = AgentId.make("ada");
const CAMP = ChannelId.make("camp-1");

const layer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  BriefLogLive.pipe(Layer.provide(EventJournal.layer)),
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | BriefLog | EventJournal | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>);

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
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
  );
  yield* repo.upsertChannel(new Channel({ id: CAMP, ownerHobId: ADA, title: "Launch", createdAt: NOW, updatedAt: NOW }));
});

const draft = (fields: Partial<BriefDraft> = {}): BriefDraft => ({
  channelId: CAMP,
  text: "Emails go out on Wednesdays.",
  basis: 5,
  source: "brain",
  ...fields,
});

const briefEntries = Effect.flatMap(EventJournal, (journal) => journal.readAfter(0, 10_000)).pipe(
  Effect.map((entries) => entries.filter((entry) => entry.payload._tag === "BriefWritten")),
);

describe("the brief store", () => {
  // covers ADR 037 (Records), STD-ARCH-014, STD-ARCH-016
  it("writes a brief once with its BriefWritten and the cursor, and a replay writes nothing (#1384)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const log = yield* BriefLog;
        const start = yield* log.cursor;
        const first = yield* log.record(start + 5, [draft({ basis: start + 5 })], NOW);
        // The same page again, as after a restart that lost the cursor, then an older one.
        const again = yield* log.record(start + 5, [draft({ basis: start + 5 })], LATER);
        const older = yield* log.record(start + 2, [draft({ basis: start + 2, text: "Older." })], LATER);
        return {
          start,
          first,
          again,
          older,
          cursor: yield* log.cursor,
          brief: yield* log.briefOf(CAMP),
          entries: yield* briefEntries,
        };
      }),
    );
    expect(result.first.map((entry) => [entry.type, entry.correlation.channelId])).toEqual([["BriefWritten", CAMP]]);
    expect(result.again).toEqual([]);
    expect(result.older).toEqual([]);
    // The cursor never moves back.
    expect(result.cursor).toBe(result.start + 5);
    expect(Option.getOrThrow(result.brief)).toMatchObject({
      channelId: CAMP,
      text: "Emails go out on Wednesdays.",
      writtenBy: { kind: "hub", id: "hub" },
      source: "brain",
      basis: result.start + 5,
      writtenAt: NOW,
      revision: result.first[0]?.sequence,
    });
    expect(result.entries).toHaveLength(1);
  });

  // covers ADR 037 (Records, The hub's brain)
  it("keeps the last brief when the brain failed, and writes the rule's when there is none yet (#1384)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const log = yield* BriefLog;
        const start = yield* log.cursor;
        // No brief yet: the rule's text stands in, so a brief appears.
        yield* log.record(start + 1, [draft({ basis: start + 1, text: "Plain.", source: "fallback" })], NOW);
        const plain = yield* log.briefOf(CAMP);
        yield* log.record(start + 2, [draft({ basis: start + 2, text: "The brain's." })], NOW);
        // The brain fails later: its brief stays.
        const failed = yield* log.record(
          start + 3,
          [draft({ basis: start + 3, text: "Plain.", source: "fallback" })],
          LATER,
        );
        return { plain, failed, brief: yield* log.briefOf(CAMP) };
      }),
    );
    expect(Option.getOrThrow(result.plain)).toMatchObject({ text: "Plain.", source: "rule" });
    expect(result.failed).toEqual([]);
    expect(Option.getOrThrow(result.brief)).toMatchObject({ text: "The brain's.", source: "brain", writtenAt: NOW });
  });

  // covers ADR 037 (Records)
  it("names the channel of a Task, and writes no brief for a channel that is not there (#1384)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* TaskRepository;
        const task = (id: string, channelId: ChannelId | null) =>
          tasks.createTask({
            task: {
              id: TaskId.make(id),
              ownerId: ADA,
              parentId: null,
              channelId,
              brief: id,
              dependsOn: [],
              createdAt: NOW,
            },
            delegation: null,
            milestones: [],
          });
        yield* task("in-camp", CAMP);
        yield* task("nowhere", null);
        const log = yield* BriefLog;
        const channels = yield* log.channelsOfTasks([
          TaskId.make("in-camp"),
          TaskId.make("nowhere"),
          TaskId.make("gone"),
        ]);
        const none = yield* log.channelsOfTasks([]);
        const start = yield* log.cursor;
        const missing = yield* log.record(
          start + 1,
          [draft({ channelId: ChannelId.make("gone"), basis: start + 1 })],
          NOW,
        );
        return { channels, none, missing, cursor: yield* log.cursor, start };
      }),
    );
    expect(result.channels).toEqual([CAMP]);
    expect(result.none).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.cursor).toBe(result.start + 1);
  });
});
