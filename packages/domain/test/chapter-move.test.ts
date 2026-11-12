import { describe, expect, it } from "vitest";
import {
  AgentId,
  Chapter,
  ChapterId,
  type ChapterMoveInput,
  type ChapterMovePlan,
  ChapterNotFound,
  ChapterRefused,
  type ChapterState,
  planMove,
  Thread,
  ThreadId,
} from "../src/index.ts";

// Issue #1385 (ADR 037, Moving a chapter into a camp moves it): the pure rule of a move. The thread
// keeps a stub, the camp takes the chapter as its live one, and each thread keeps one live chapter.

const CHAT = ThreadId.make("chat-1");
const CAMP = ThreadId.make("camp-1");
const ADA = AgentId.make("ada");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

const chapter = (threadId: ThreadId, id: string, number: number, state: ChapterState, title: string | null = null) =>
  new Chapter({
    id: ChapterId.make(id),
    threadId,
    number,
    title,
    summary: state === "resting" ? `Summary of ${id}` : null,
    state,
    startedAt: at(number),
    endedAt: state === "live" ? null : at(number + 1),
    movedTo: null,
  });

const thread = (id: ThreadId, fields: Partial<Thread> = {}) =>
  new Thread({ id, agentId: ADA, title: id, kind: "camp", createdAt: at(0), updatedAt: at(0), ...fields });

const chatChapters = [chapter(CHAT, "c1", 1, "resting", "Lamps"), chapter(CHAT, "c2", 2, "live", "Billing")];

const input = (fields: Partial<ChapterMoveInput> = {}): ChapterMoveInput => ({
  from: thread(CHAT, { kind: "chat" }),
  chapters: chatChapters,
  chapterId: ChapterId.make("c1"),
  chapterEmpty: false,
  to: thread(CAMP),
  campChapters: [chapter(CAMP, "k1", 1, "live")],
  campLiveEmpty: true,
  ids: { landed: ChapterId.make("landed"), nextLive: ChapterId.make("next") },
  at: at(30),
  ...fields,
});

const shape = (chapters: ReadonlyArray<Chapter>) =>
  chapters.map((each) => [each.id, each.number, each.state, each.title, each.movedTo]);

const planned = (fields: Partial<ChapterMoveInput> = {}) => planMove(input(fields)) as ChapterMovePlan;

describe("planMove", () => {
  it("[TC-CH-1385-10] leaves a stub of a resting chapter, and fills a new camp's empty live chapter with it", () => {
    const plan = planned();
    expect(plan.stub).toMatchObject({ id: "c1", state: "moved", movedTo: CAMP, threadId: CHAT });
    expect(shape(plan.from.chapters)).toEqual([
      ["c1", 1, "moved", "Lamps", CAMP],
      ["c2", 2, "live", "Billing", null],
    ]);
    expect(plan.from.changed.map((each) => each.id)).toEqual(["c1"]);
    // The camp's first chapter takes the moved chapter's title, and its summary is written again.
    expect(plan.landed).toMatchObject({ id: "k1", threadId: CAMP, state: "live", title: "Lamps", summary: null });
    expect(shape(plan.camp.chapters)).toEqual([["k1", 1, "live", "Lamps", null]]);
  });

  it("[TC-CH-1385-11] moves the live chapter after a camp's own topic, and gives each thread one live chapter", () => {
    const plan = planned({
      chapterId: ChapterId.make("c2"),
      campChapters: [chapter(CAMP, "k1", 1, "live", "Plan")],
      campLiveEmpty: false,
    });
    expect(shape(plan.from.chapters)).toEqual([
      ["c1", 1, "resting", "Lamps", null],
      ["c2", 2, "moved", "Billing", CAMP],
      ["next", 3, "live", null, null],
    ]);
    expect(plan.stub).toMatchObject({ endedAt: at(30) });
    expect(shape(plan.camp.chapters)).toEqual([
      ["k1", 1, "resting", "Plan", null],
      ["landed", 2, "live", "Billing", null],
    ]);
    // The resting one comes first, so the one-live index never sees two.
    expect(plan.camp.changed.map((each) => [each.id, each.state])).toEqual([
      ["k1", "resting"],
      ["landed", "live"],
    ]);
    for (const chapters of [plan.from.chapters, plan.camp.chapters]) {
      expect(chapters.filter((each) => each.state === "live")).toHaveLength(1);
    }
  });

  it("[TC-CH-1385-12] refuses a closed thread, itself, anything but an open camp of the hob's, a moved chapter and an empty one", () => {
    const reason = (fields: Partial<ChapterMoveInput>) => (planMove(input(fields)) as ChapterRefused).reason;
    expect(reason({ from: thread(CHAT, { kind: "chat", state: "archived", archivedAt: at(1) }) })).toBe(
      "thread-closed",
    );
    expect(reason({ to: thread(CHAT, { kind: "chat" }) })).toBe("same-thread");
    expect(reason({ to: thread(ThreadId.make("chat-2"), { kind: "chat" }) })).toBe("not-a-camp");
    expect(reason({ to: thread(CAMP, { agentId: AgentId.make("bo") }) })).toBe("not-a-camp");
    expect(reason({ to: thread(CAMP, { state: "archived", archivedAt: at(1) }) })).toBe("not-a-camp");
    expect(
      reason({
        chapters: [
          new Chapter({ ...(chatChapters[0] as Chapter), state: "moved", movedTo: CAMP }),
          chatChapters[1] as Chapter,
        ],
      }),
    ).toBe("moved");
    expect(reason({ chapterId: ChapterId.make("c2"), chapterEmpty: true })).toBe("live-chapter-empty");
    expect(planMove(input({ chapterId: ChapterId.make("nope") }))).toEqual(
      new ChapterNotFound({ threadId: CHAT, chapterId: ChapterId.make("nope") }),
    );
    expect(planMove(input())).not.toBeInstanceOf(ChapterRefused);
  });
});
