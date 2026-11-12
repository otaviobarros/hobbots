import { Schema } from "effect";
import {
  Chapter,
  ChapterNotFound,
  type ChapterPlan,
  type ChapterRefusal,
  ChapterRefused,
  ChapterStates,
  chapterPlan,
  firstChapter,
  IllegalChapterTransition,
} from "./chapter.ts";
import type { ChapterId } from "./ids.ts";
import { Thread, ThreadLifecycle } from "./thread.ts";

/**
 * Moving a chapter into a camp (ADR 037): the chapter's messages and records leave the thread for
 * the camp, and the thread keeps the chapter as a stub, moved, that links there. In the camp they
 * make its live chapter: the topic goes on there. A camp whose live chapter has no message yet, such
 * as one just made, takes them in that chapter; otherwise its live chapter rests and a new one holds
 * them. Moving the thread's live chapter starts a new, empty one in its place, so the thread always
 * has a live chapter for its next message.
 */

/** What moving a chapter reads, as the command finds it in its transaction. */
export interface ChapterMoveInput {
  /** The thread the chapter is in, and its chapters in order. */
  readonly from: Thread;
  readonly chapters: ReadonlyArray<Chapter>;
  readonly chapterId: ChapterId;
  /** Whether the chapter holds no message, which only a live chapter can. */
  readonly chapterEmpty: boolean;
  /** The camp it moves into, and its chapters in order. */
  readonly to: Thread;
  readonly campChapters: ReadonlyArray<Chapter>;
  /** Whether the camp's live chapter holds no message yet. */
  readonly campLiveEmpty: boolean;
  /** The ids of the chapters the move may make: the camp's new live chapter, and the thread's. */
  readonly ids: { readonly landed: ChapterId; readonly nextLive: ChapterId };
  readonly at: string;
}

/** What a move writes. */
export interface ChapterMovePlan {
  /** The chapter as the thread keeps it: moved, linking to the camp. */
  readonly stub: Chapter;
  /** The camp's chapter that now holds the moved messages and records: its live one. */
  readonly landed: Chapter;
  /** The thread's chapters and the camp's afterwards, each with the ones the move wrote or made. */
  readonly from: ChapterPlan;
  readonly camp: ChapterPlan;
}

const refused = (input: ChapterMoveInput, reason: ChapterRefusal) =>
  new ChapterRefused({ threadId: input.from.id, reason });

/** Why the threads refuse the move, or null: an open thread, into another open camp of its hob. */
const threadsRefusal = (input: ChapterMoveInput): ChapterRefusal | null => {
  if (!ThreadLifecycle.isOpen(input.from)) return "thread-closed";
  if (input.to.id === input.from.id) return "same-thread";
  const camp = input.to;
  if (camp.kind !== "camp" || camp.agentId !== input.from.agentId || !ThreadLifecycle.isOpen(camp)) {
    return "not-a-camp";
  }
  return null;
};

/** The chapter as it leaves the thread, rested first when it was live, with the thread's next live one. */
const leaving = (input: ChapterMoveInput, chapter: Chapter) => {
  if (!ChapterStates.isLive(chapter)) return { rested: chapter, nextLive: null };
  const rested = ChapterStates.transition(chapter, { _tag: "End", at: input.at });
  const nextLive = new Chapter({
    ...firstChapter(input.ids.nextLive, input.from.id, input.at),
    number: input.chapters.length + 1,
  });
  return { rested, nextLive };
};

/** The camp's chapters with the moved one as their live chapter, and that chapter. */
const landing = (input: ChapterMoveInput, moved: Chapter) => {
  const live = input.campChapters.find(ChapterStates.isLive);
  if (live !== undefined && input.campLiveEmpty) {
    const landed = new Chapter({ ...live, title: moved.title ?? live.title, summary: null });
    return { landed, chapters: input.campChapters.map((chapter) => (chapter === live ? landed : chapter)) };
  }
  const landed = new Chapter({
    id: input.ids.landed,
    threadId: input.to.id,
    number: input.campChapters.length + 1,
    title: moved.title,
    summary: null,
    state: "live",
    startedAt: moved.startedAt,
    endedAt: null,
    movedTo: null,
  });
  if (live === undefined) return { landed, chapters: [...input.campChapters, landed] };
  const rested = ChapterStates.transition(live, { _tag: "End", at: input.at });
  if (rested instanceof IllegalChapterTransition) return rested;
  return { landed, chapters: [...input.campChapters.map((chapter) => (chapter === live ? rested : chapter)), landed] };
};

/**
 * The pure rule of moving a chapter into a camp (ADR 037). Refused for a closed thread, into itself,
 * into anything but an open camp of the same hob, for a chapter moved already, and for an empty one.
 */
export const planMove = (
  input: ChapterMoveInput,
): ChapterMovePlan | ChapterRefused | ChapterNotFound | IllegalChapterTransition => {
  const reason = threadsRefusal(input);
  if (reason !== null) return refused(input, reason);
  const chapter = input.chapters.find((each) => each.id === input.chapterId);
  if (chapter === undefined) return new ChapterNotFound({ threadId: input.from.id, chapterId: input.chapterId });
  if (!ChapterStates.isInThread(chapter)) return refused(input, "moved");
  if (input.chapterEmpty) return refused(input, "live-chapter-empty");
  const { rested, nextLive } = leaving(input, chapter);
  if (rested instanceof IllegalChapterTransition) return rested;
  const stub = ChapterStates.transition(rested, { _tag: "Move", to: input.to.id });
  if (stub instanceof IllegalChapterTransition) return stub;
  const landed = landing(input, chapter);
  if (landed instanceof IllegalChapterTransition) return landed;
  const after = input.chapters.map((each) => (each === chapter ? stub : each));
  return {
    stub,
    landed: landed.landed,
    from: chapterPlan(input.chapters, nextLive === null ? after : [...after, nextLive]),
    camp: chapterPlan(input.campChapters, landed.chapters),
  };
};

/** A chapter moved into a camp, as the command answers it: both threads afterwards, and the stub left behind. */
export class ChapterMove extends Schema.Class<ChapterMove>("ChapterMove")({
  thread: Thread,
  camp: Thread,
  stub: Chapter,
  chapters: Schema.Array(Chapter),
  campChapters: Schema.Array(Chapter),
}) {}
