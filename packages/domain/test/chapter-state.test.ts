import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Chapter,
  type ChapterEvent,
  ChapterId,
  ChapterNotFound,
  type ChapterPlan,
  ChapterRefused,
  type ChapterState,
  ChapterStateMachine,
  ChapterStates,
  IllegalChapterTransition,
  MessageId,
  planMerge,
  planSplit,
  planStart,
  ThreadId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const THREAD = ThreadId.make("thread-1");
const CAMP = ThreadId.make("camp-1");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 11) + minute * 60_000).toISOString();

const chapter = (id: string, number: number, state: ChapterState, fields: Partial<Chapter> = {}) =>
  new Chapter({
    id: ChapterId.make(id),
    threadId: THREAD,
    number,
    title: null,
    summary: null,
    state,
    startedAt: at(number),
    endedAt: state === "live" ? null : at(number + 1),
    movedTo: state === "moved" ? CAMP : null,
    ...fields,
  });

/** What the model tracks of a chapter: every field a rule writes. */
interface ChapterView {
  readonly state: ChapterState;
  readonly endedAt: string | null;
  readonly movedTo: string | null;
}

const view = (c: Chapter): ChapterView => ({ state: c.state, endedAt: c.endedAt, movedTo: c.movedTo });

// What each event does to a chapter, as ADR 037 describes chapters, kept apart from the machine.
const stepModel = (m: ChapterView, e: ChapterEvent): ChapterView | "refused" => {
  switch (e._tag) {
    case "End":
      return m.state === "live" ? { ...m, state: "resting", endedAt: e.at } : "refused";
    case "Split":
      return m.state === "moved" ? "refused" : { ...m, state: "resting", endedAt: e.at };
    case "Absorb":
      if (m.state !== "resting") return "refused";
      return e.live ? { ...m, state: "live", endedAt: null } : { ...m, endedAt: e.endedAt };
    case "Move":
      return m.state === "resting" && e.to !== THREAD ? { ...m, state: "moved", movedTo: e.to } : "refused";
  }
};

const times = fc.integer({ min: 0, max: 10_000 }).map(at);
const events: fc.Arbitrary<ChapterEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("End" as const), at: times }),
  fc.record({ _tag: fc.constant("Split" as const), at: times }),
  fc.record({ _tag: fc.constant("Absorb" as const), live: fc.boolean(), endedAt: fc.option(times, { nil: null }) }),
  fc.record({ _tag: fc.constant("Move" as const), to: fc.constantFrom(THREAD, CAMP, ThreadId.make("camp-2")) }),
);

describe("ChapterStateMachine", () => {
  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-10] declares live, resting and moved, and which events lead where", () => {
    expect(ChapterStateMachine.states).toEqual(["live", "resting", "moved"]);
    expect(ChapterStateMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["End", ["live"], "resting", false],
      ["Split", ["live", "resting"], "resting", false],
      ["Absorb", ["resting"], "live", true],
      ["Absorb", ["resting"], "resting", false],
      ["Move", ["resting"], "moved", true],
    ]);
    const moved = ChapterStateMachine.transition(chapter("c1", 1, "moved"), { _tag: "End", at: at(9) });
    expect(moved).toEqual(
      new IllegalChapterTransition({ chapterId: ChapterId.make("c1"), from: "moved", to: "resting" }),
    );
    expect(ChapterStates.isLive(chapter("c1", 1, "live"))).toBe(true);
    expect(ChapterStates.isInThread(chapter("c1", 1, "moved"))).toBe(false);
  });

  // covers ADR 037 (Chapters), STD-ARCH-013
  it("[TC-CH-1379-11] agrees with its model on random runs of events", () => {
    agreesWithModel({
      machine: ChapterStateMachine,
      records: fc.constantFrom<ChapterState>("live", "resting", "moved").map((state) => chapter("c1", 1, state)),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalChapterTransition => result instanceof IllegalChapterTransition,
    });
  });
});

const plan = (planned: ChapterPlan | ChapterRefused | ChapterNotFound | IllegalChapterTransition): ChapterPlan => {
  if (!("changed" in planned)) throw new Error(`Refused: ${planned._tag}`);
  return planned;
};
const shape = (chapters: ReadonlyArray<Chapter>) => chapters.map((c) => [c.id, c.number, c.state, c.endedAt]);

describe("chapter commands' rules", () => {
  const two = [chapter("c1", 1, "resting", { endedAt: at(5) }), chapter("c2", 2, "live", { startedAt: at(5) })];

  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-12] starts a chapter after the live one, which rests, and refuses an empty title or an empty live chapter", () => {
    const started = plan(
      planStart(THREAD, two, { id: ChapterId.make("c3"), title: "  The\n garden ", at: at(9), liveHasMessages: true }),
    );
    expect(shape(started.chapters)).toEqual([
      ["c1", 1, "resting", at(5)],
      ["c2", 2, "resting", at(9)],
      ["c3", 3, "live", null],
    ]);
    expect(started.chapters[2]).toMatchObject({ title: "The garden", startedAt: at(9) });
    expect(started.changed.map((c) => c.id)).toEqual(["c2", "c3"]);
    const input = { id: ChapterId.make("c3"), at: at(9) };
    expect(planStart(THREAD, two, { ...input, title: " ", liveHasMessages: true })).toEqual(
      new ChapterRefused({ threadId: THREAD, reason: "empty-title" }),
    );
    expect(planStart(THREAD, two, { ...input, title: "Next", liveHasMessages: false })).toEqual(
      new ChapterRefused({ threadId: THREAD, reason: "live-chapter-empty" }),
    );
  });

  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-13] splits a chapter at a message into the chapter after it, numbering the rest again", () => {
    const point = { messageId: MessageId.make("m4"), chapterId: ChapterId.make("c1"), createdAt: at(3), first: false };
    const split = plan(planSplit(THREAD, two, point, { id: ChapterId.make("n"), title: "Lamps" }));
    expect(shape(split.chapters)).toEqual([
      ["c1", 1, "resting", at(3)],
      ["n", 2, "resting", at(5)],
      ["c2", 3, "live", null],
    ]);
    // Splitting the live chapter makes its second half the live one.
    const live = plan(
      planSplit(
        THREAD,
        two,
        { ...point, chapterId: ChapterId.make("c2"), createdAt: at(7) },
        {
          id: ChapterId.make("n"),
          title: "Lamps",
        },
      ),
    );
    expect(shape(live.chapters)).toEqual([
      ["c1", 1, "resting", at(5)],
      ["c2", 2, "resting", at(7)],
      ["n", 3, "live", null],
    ]);
    expect(live.changed.map((c) => c.id)).toEqual(["c2", "n"]);
    expect(planSplit(THREAD, two, { ...point, first: true }, { id: ChapterId.make("n"), title: "Lamps" })).toEqual(
      new ChapterRefused({ threadId: THREAD, reason: "chapter-start" }),
    );
    expect(planSplit(THREAD, two, null, { id: ChapterId.make("n"), title: "Lamps" })).toEqual(
      new ChapterRefused({ threadId: THREAD, reason: "message-not-found" }),
    );
  });

  // covers ADR 037 (Chapters)
  it("[TC-CH-1379-14] merges a chapter into the one before it, which is live when the merged one was", () => {
    const merged = plan(planMerge(THREAD, two, ChapterId.make("c2")));
    expect(shape(merged.chapters)).toEqual([["c1", 1, "live", null]]);
    const three = [...two.slice(0, 1), chapter("c2", 2, "resting", { endedAt: at(7) }), chapter("c3", 3, "live")];
    const middle = plan(planMerge(THREAD, three, ChapterId.make("c2")));
    expect(shape(middle.chapters)).toEqual([
      ["c1", 1, "resting", at(7)],
      ["c3", 2, "live", null],
    ]);
    expect(planMerge(THREAD, two, ChapterId.make("c1"))).toEqual(
      new ChapterRefused({ threadId: THREAD, reason: "first-chapter" }),
    );
    expect(planMerge(THREAD, two, ChapterId.make("gone"))).toEqual(
      new ChapterNotFound({ threadId: THREAD, chapterId: ChapterId.make("gone") }),
    );
    // A moved chapter takes nothing in.
    const moved = [chapter("c1", 1, "moved"), chapter("c2", 2, "live")];
    expect(planMerge(THREAD, moved, ChapterId.make("c2"))).toBeInstanceOf(IllegalChapterTransition);
  });
});
