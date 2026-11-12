import { type Chapter, type ChapterId, ChapterStates, type Message } from "@hobbots/domain";

// How the transcript is divided by its chapters (ADR 037, #1382). The chapters and each message's
// chapter come from the hub; this only lays the messages out under the chapter they belong to.

/** One chapter of the transcript with its messages, or the whole transcript before its chapters are read. */
export interface ChapterSection {
  /** The chapter, or null while the thread's chapters are not read yet. */
  readonly chapter: Chapter | null;
  readonly messages: ReadonlyArray<Message>;
}

/**
 * The transcript under its chapters, in the thread's order. A moved chapter left the thread, so it
 * has no section, nor does a resting chapter without messages. The live chapter always has one, even
 * empty, since the hob just started it. A message whose chapter the list does not hold yet, as one
 * that arrived before a chapter event, joins the live chapter, where every new message goes.
 */
export const chapterSections = (
  transcript: ReadonlyArray<Message>,
  chapters: ReadonlyArray<Chapter> | undefined,
): ReadonlyArray<ChapterSection> => {
  const inThread = chapters?.filter(ChapterStates.isInThread) ?? [];
  const live = inThread.find(ChapterStates.isLive) ?? inThread.at(-1);
  if (live === undefined) return [{ chapter: null, messages: transcript }];
  const known = new Set(inThread.map((chapter) => chapter.id));
  const of = (message: Message): ChapterId =>
    message.chapterId !== null && known.has(message.chapterId) ? message.chapterId : live.id;
  return inThread
    .map((chapter) => ({ chapter, messages: transcript.filter((message) => of(message) === chapter.id) }))
    .filter((section) => section.messages.length > 0 || section.chapter === live);
};

/**
 * Whether the transcript shows its chapters: once it has more than one, or its only chapter has a
 * title. A chat that never changed topic reads as it always did.
 */
export const showsChapters = (sections: ReadonlyArray<ChapterSection>): boolean =>
  sections.length > 1 || (sections[0]?.chapter?.title ?? null) !== null;

/**
 * The resting chapters that show their messages without being opened: the one a search opened, and
 * the one the hob just ended while the new live chapter has no message yet, so ending a chapter
 * does not fold away the reply that ended it.
 */
export const shownWithoutOpening = (
  sections: ReadonlyArray<ChapterSection>,
  focused: ChapterId | null,
): ReadonlySet<ChapterId> => {
  const shown = new Set<ChapterId>();
  if (focused !== null) shown.add(focused);
  const last = sections.at(-1);
  const before = sections.at(-2)?.chapter;
  if (last?.chapter && ChapterStates.isLive(last.chapter) && last.messages.length === 0 && before) shown.add(before.id);
  return shown;
};

/** How you left a resting chapter: opened or folded. One you never touched follows its default. */
export type FoldChoice = "open" | "folded";

/**
 * What you did to the chapters' folds: opened or folded one (`Toggle`, from how it showed), or chose
 * a search result in one (`Reveal`), which opens it again even after you folded it.
 */
export type FoldEvent =
  | { readonly _tag: "Toggle"; readonly chapterId: ChapterId; readonly folded: boolean }
  | { readonly _tag: "Reveal"; readonly chapterId: ChapterId };

/** How you left each chapter after `event`. */
export const foldStep = (
  choices: ReadonlyMap<ChapterId, FoldChoice>,
  event: FoldEvent,
): ReadonlyMap<ChapterId, FoldChoice> => {
  if (event._tag === "Toggle") return new Map(choices).set(event.chapterId, event.folded ? "open" : "folded");
  if (choices.get(event.chapterId) !== "folded") return choices;
  const next = new Map(choices);
  next.delete(event.chapterId);
  return next;
};

/**
 * Whether a chapter shows folded to its summary: never the live one; a resting one as you left it,
 * else folded unless it shows anyway.
 */
export const isFolded = (
  chapter: Chapter,
  choices: ReadonlyMap<ChapterId, FoldChoice>,
  shown: ReadonlySet<ChapterId>,
): boolean => {
  if (ChapterStates.isLive(chapter)) return false;
  const choice = choices.get(chapter.id);
  return choice === undefined ? !shown.has(chapter.id) : choice === "folded";
};

/** The chapter a message is in, among the sections, or null. */
export const chapterOf = (sections: ReadonlyArray<ChapterSection>, messageId: string | undefined): ChapterId | null =>
  messageId === undefined
    ? null
    : (sections.find((section) => section.messages.some((message) => message.id === messageId))?.chapter?.id ?? null);

/** What the Focus chip's label says about the chapters: the live one's title and how many rest. */
export const chapterFocus = (
  chapters: ReadonlyArray<Chapter> | undefined,
): { readonly title: string | null; readonly resting: number } => {
  const inThread = chapters?.filter(ChapterStates.isInThread) ?? [];
  return {
    title: inThread.find(ChapterStates.isLive)?.title ?? null,
    resting: inThread.filter((chapter) => !ChapterStates.isLive(chapter)).length,
  };
};
