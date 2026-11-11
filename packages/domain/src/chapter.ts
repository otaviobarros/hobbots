import { Schema } from "effect";
import { ChapterId, type MessageId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";

/** Where a chapter stands (ADR 037), held by `ChapterStateMachine`. */
export const ChapterState = Schema.Literals(["live", "resting", "moved"]);
export type ChapterState = typeof ChapterState.Type;

/** The longest title a chapter takes, as a thread's (`THREAD_TITLE_MAX`). */
export const CHAPTER_TITLE_MAX = 60;

/**
 * One topic of a thread's transcript (ADR 037). Every message belongs to exactly one chapter, and a
 * thread has exactly one live chapter, its last, which the database holds. A runtime session belongs
 * to one chapter, so a new chapter starts a new session.
 */
export class Chapter extends Schema.Class<Chapter>("Chapter")({
  id: ChapterId,
  threadId: ThreadId,
  /** Its place in the thread, from 1, with no gaps: a split or a merge numbers the chapters after it again. */
  number: Schema.Int,
  /** What the chapter is about, or null for one nobody named, such as a thread's first. */
  title: Schema.NullOr(Schema.String),
  /** A one-line summary, written once the chapter rests (#1380); null until then. */
  summary: Schema.NullOr(Schema.String),
  /** Only `ChapterStateMachine` changes it, and code outside reads it through `ChapterStates`. */
  state: ChapterState,
  startedAt: Schema.String,
  /** When the chapter stopped taking messages, or null while it is live. */
  endedAt: Schema.NullOr(Schema.String),
  /** The camp a moved chapter now lives in, or null (#1364). */
  movedTo: Schema.NullOr(ThreadId),
  revision: Revision,
}) {}

/** What can happen to one chapter. */
export type ChapterEvent =
  /** The thread starts a new chapter after this one. */
  | { readonly _tag: "End"; readonly at: string }
  /** The chapter is cut at one of its messages; the ones from there on make the chapter after it. */
  | { readonly _tag: "Split"; readonly at: string }
  /**
   * The chapter after this one merges into it, bringing its messages. `live` and `endedAt` are that
   * chapter's: the merged chapter is live when it was, and ends when it did.
   */
  | { readonly _tag: "Absorb"; readonly live: boolean; readonly endedAt: string | null }
  /** The chapter moves into a camp, leaving a stub (#1364). */
  | { readonly _tag: "Move"; readonly to: ThreadId };

/** A change to a chapter its state does not allow. */
export class IllegalChapterTransition extends Schema.TaggedError<IllegalChapterTransition>()(
  "IllegalChapterTransition",
  { chapterId: ChapterId, from: ChapterState, to: ChapterState },
) {}

/** A chapter's lifecycle (ADR 037), declared once. */
export const ChapterStateMachine = defineMachine<ChapterState, ChapterEvent, Chapter, IllegalChapterTransition>({
  name: "ChapterState",
  states: {
    live: "The thread's current topic: new messages join it, and its runtime sessions are resumed",
    resting: "An earlier topic: it takes no new messages, and its sessions are never resumed",
    moved: "Moved into a camp; the thread keeps it as a stub that links there",
  },
  field: "state",
  events: {
    End: {
      from: ["live"],
      to: "resting",
      apply: (chapter, e) => new Chapter({ ...chapter, state: "resting", endedAt: e.at }),
    },
    // Splitting the live chapter makes its second half the live one.
    Split: {
      from: ["live", "resting"],
      to: "resting",
      apply: (chapter, e) => new Chapter({ ...chapter, state: "resting", endedAt: e.at }),
    },
    Absorb: [
      {
        from: ["resting"],
        to: "live",
        guard: (_, e) => e.live,
        apply: (chapter) => new Chapter({ ...chapter, state: "live", endedAt: null }),
      },
      {
        from: ["resting"],
        to: "resting",
        apply: (chapter, e) => new Chapter({ ...chapter, endedAt: e.endedAt }),
      },
    ],
    Move: {
      from: ["resting"],
      to: "moved",
      guard: (chapter, e) => e.to !== chapter.threadId,
      apply: (chapter, e) => new Chapter({ ...chapter, state: "moved", movedTo: e.to }),
    },
  },
  illegal: (chapter, _, to) => new IllegalChapterTransition({ chapterId: chapter.id, from: chapter.state, to }),
});

/** `ChapterStateMachine` with the questions code outside this module asks of a chapter's state. */
export const ChapterStates = {
  ...ChapterStateMachine,
  isLive: (chapter: Chapter): boolean => chapter.state === "live",
  /** Whether the chapter is still in its thread's transcript, live or resting, not moved out. */
  isInThread: (chapter: Chapter): boolean => chapter.state !== "moved",
};

/**
 * Why a chapter command changed nothing. `empty-title`: a chapter's title has no text.
 * `live-chapter-empty`: the live chapter has no message yet, so there is nothing to end.
 * `message-not-found`: the message to split at is not in the thread. `chapter-start`: it is the
 * first message of its chapter, which would leave an empty chapter. `first-chapter`: the chapter
 * to merge has no chapter before it. `moved`: a chapter it touches moved into a camp.
 * `thread-closed`: the thread is archived or superseded, so its chapters stay as they are.
 */
export const ChapterRefusal = Schema.Literals([
  "thread-closed",
  "empty-title",
  "live-chapter-empty",
  "message-not-found",
  "chapter-start",
  "first-chapter",
  "moved",
]);
export type ChapterRefusal = typeof ChapterRefusal.Type;

export class ChapterRefused extends Schema.TaggedError<ChapterRefused>()("ChapterRefused", {
  threadId: ThreadId,
  reason: ChapterRefusal,
}) {}

export class ChapterNotFound extends Schema.TaggedError<ChapterNotFound>()("ChapterNotFound", {
  threadId: ThreadId,
  chapterId: ChapterId,
}) {}

/** A title as a chapter keeps it: one line, cut at `CHAPTER_TITLE_MAX`; null when it has no text. */
export const chapterTitle = (title: string): string | null => {
  const line = title.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > CHAPTER_TITLE_MAX ? `${line.slice(0, CHAPTER_TITLE_MAX - 1).trimEnd()}…` : line;
};

/** The first chapter of a new thread, which takes its history. */
export const firstChapter = (id: ChapterId, threadId: ThreadId, startedAt: string): Chapter =>
  new Chapter({
    id,
    threadId,
    number: 1,
    title: null,
    summary: null,
    state: "live",
    startedAt,
    endedAt: null,
    movedTo: null,
  });

/** The thread's chapters after a command, in order, with what changed. */
export interface ChapterPlan {
  /** Every chapter of the thread after the change, numbered from 1 in order. */
  readonly chapters: ReadonlyArray<Chapter>;
  /** The chapters the change wrote or made. */
  readonly changed: ReadonlyArray<Chapter>;
}

type Planned = ChapterPlan | ChapterRefused | IllegalChapterTransition;

const renumbered = (chapters: ReadonlyArray<Chapter>): ReadonlyArray<Chapter> =>
  chapters.map((chapter, index) =>
    chapter.number === index + 1 ? chapter : new Chapter({ ...chapter, number: index + 1 }),
  );

/** The chapters in `after` that differ from `before`, or are new. */
const changedIn = (before: ReadonlyArray<Chapter>, after: ReadonlyArray<Chapter>) => {
  const known = new Map(before.map((chapter) => [chapter.id, chapter]));
  return after.filter((chapter) => known.get(chapter.id) !== chapter);
};

const planned = (before: ReadonlyArray<Chapter>, after: ReadonlyArray<Chapter>): ChapterPlan => {
  const chapters = renumbered(after);
  return { chapters, changed: changedIn(before, chapters) };
};

const refused = (threadId: ThreadId, reason: ChapterRefusal) => new ChapterRefused({ threadId, reason });

/**
 * Ends the live chapter and starts chapter `id` after it, titled `title`, at `at`. Refused when the
 * title has no text or the live chapter has no message yet.
 */
export const planStart = (
  threadId: ThreadId,
  chapters: ReadonlyArray<Chapter>,
  input: { readonly id: ChapterId; readonly title: string; readonly at: string; readonly liveHasMessages: boolean },
): Planned => {
  const title = chapterTitle(input.title);
  if (title === null) return refused(threadId, "empty-title");
  if (!input.liveHasMessages) return refused(threadId, "live-chapter-empty");
  const live = chapters.find(ChapterStates.isLive);
  if (live === undefined) return refused(threadId, "moved");
  const ended = ChapterStateMachine.transition(live, { _tag: "End", at: input.at });
  if (ended instanceof IllegalChapterTransition) return ended;
  const started = new Chapter({
    ...firstChapter(input.id, threadId, input.at),
    number: chapters.length + 1,
    title,
  });
  return planned(chapters, [...chapters.map((chapter) => (chapter === live ? ended : chapter)), started]);
};

/** The message a split starts its new chapter at, as the thread stores it. */
export interface SplitPoint {
  readonly messageId: MessageId;
  readonly chapterId: ChapterId;
  readonly createdAt: string;
  /** Whether it is the first message of its chapter. */
  readonly first: boolean;
}

/**
 * Cuts the chapter `point` is in: its messages from `point` on make chapter `id` right after it,
 * titled `title`. The new chapter is live when the one it came from was, and ends when it did.
 */
export const planSplit = (
  threadId: ThreadId,
  chapters: ReadonlyArray<Chapter>,
  point: SplitPoint | null,
  input: { readonly id: ChapterId; readonly title: string },
): Planned => {
  const title = chapterTitle(input.title);
  if (title === null) return refused(threadId, "empty-title");
  if (point === null) return refused(threadId, "message-not-found");
  if (point.first) return refused(threadId, "chapter-start");
  const index = chapters.findIndex((chapter) => chapter.id === point.chapterId);
  const from = chapters[index];
  if (from === undefined) return refused(threadId, "message-not-found");
  const cut = ChapterStateMachine.transition(from, { _tag: "Split", at: point.createdAt });
  if (cut instanceof IllegalChapterTransition) return cut;
  const after = new Chapter({
    id: input.id,
    threadId,
    number: from.number + 1,
    title,
    summary: null,
    state: from.state,
    startedAt: point.createdAt,
    endedAt: from.endedAt,
    movedTo: null,
  });
  return planned(chapters, [...chapters.slice(0, index), cut, after, ...chapters.slice(index + 1)]);
};

/** Merges chapter `chapterId` into the chapter before it, which keeps its id, title and start. */
export const planMerge = (
  threadId: ThreadId,
  chapters: ReadonlyArray<Chapter>,
  chapterId: ChapterId,
): Planned | ChapterNotFound => {
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  const absorbed = chapters[index];
  if (absorbed === undefined) return new ChapterNotFound({ threadId, chapterId });
  const into = chapters[index - 1];
  if (into === undefined) return refused(threadId, "first-chapter");
  if (!ChapterStates.isInThread(absorbed)) return refused(threadId, "moved");
  const merged = ChapterStateMachine.transition(into, {
    _tag: "Absorb",
    live: ChapterStates.isLive(absorbed),
    endedAt: absorbed.endedAt,
  });
  if (merged instanceof IllegalChapterTransition) return merged;
  return planned(chapters, [...chapters.slice(0, index - 1), merged, ...chapters.slice(index + 1)]);
};
