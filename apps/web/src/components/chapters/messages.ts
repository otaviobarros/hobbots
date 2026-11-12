import { CHAPTER_TITLE_MAX, type PackPartName } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import type { ChapterChangeError, TitleProblem } from "./chapter-flows.ts";
import type { FocusGroup } from "./focus-rows.ts";

interface Named {
  readonly name: string;
}

interface Counted {
  readonly count: number;
}

const tokens = (count: number) => plural(count, { one: "1 token", other: `${formatCount(count)} tokens` });

/** User-facing copy for a thread's chapters and its Focus chip (STD-I18N-001). */
export const messages = {
  divider: {
    /** A chapter nobody named, such as a thread's first. */
    untitled: ({ number }: { readonly number: number }) => `Chapter ${formatCount(number)}`,
    started: ({ day }: { readonly day: string }) => day,
    resting: "Resting",
    /** A resting chapter whose summary is not written yet. */
    count: ({ count }: Counted) => plural(count, { one: "1 message", other: `${formatCount(count)} messages` }),
    show: "Show",
    fold: "Fold",
    showChapter: ({ title }: { readonly title: string }) => `Show ${title}`,
    foldChapter: ({ title }: { readonly title: string }) => `Fold ${title}`,
    more: ({ title }: { readonly title: string }) => `More for ${title}`,
    merge: "Merge with previous",
    merging: "Merging…",
  },
  message: {
    more: "More for this message",
    split: "Split here",
  },
  split: {
    title: "Start a new chapter here",
    lead: ({ name }: Named) =>
      `This message and everything after it in its chapter become a new chapter. ${name} starts its next turn from a fresh session.`,
    name: "Chapter title",
    placeholder: "What is this part about?",
    problems: {
      "title-missing": "Give the chapter a title.",
      "title-long": `Keep the title to ${formatCount(CHAPTER_TITLE_MAX)} characters.`,
    } satisfies Record<TitleProblem, string>,
    cancel: "Cancel",
    split: "Split here",
    splitting: "Splitting…",
    tryAgain: "Try again",
  },
  /** Why a split or a merge changed nothing, and what to do. */
  errors: {
    "thread-closed": () => "This chat is archived, so its chapters stay as they are.",
    "empty-title": () => "Give the chapter a title.",
    "live-chapter-empty": () => "This chapter has no messages yet.",
    "message-not-found": () => "That message is no longer in this chat. Its chapters changed meanwhile.",
    "chapter-start": () => "That message already starts its chapter. Pick a later one.",
    "first-chapter": () => "This is the first chapter, so there is nothing before it to merge with.",
    moved: () => "That chapter moved into a camp, so it can't change here.",
    "chapter-not-found": () => "That chapter was already merged.",
    unreachable: () => "Couldn't change the chapters. Hobbots may be reconnecting; try again in a moment.",
  } satisfies Record<ChapterChangeError, () => string>,
  dismiss: "Dismiss",
  /** When the thread's chapters could not be read; the transcript still shows, undivided. */
  unread: "Couldn't read this chat's chapters, so it shows without them.",
  focus: {
    /** The chip's label: the live chapter's title, and how many chapters rest. */
    label: ({ title, resting }: { readonly title: string | null; readonly resting: number }) =>
      title === null
        ? resting === 0
          ? "Focus"
          : `Focus · ${formatCount(resting)} resting`
        : resting === 0
          ? `Focused on ${title}`
          : `Focused on ${title} · ${formatCount(resting)} resting`,
    heading: ({ name }: Named) => `What ${name} reads each turn`,
    lastTurn: ({ used, budget }: { readonly used: number; readonly budget: number }) =>
      `The last new session read ${tokens(used)} of its ${tokens(budget)}.`,
    nextSession: ({ used, budget }: { readonly used: number; readonly budget: number }) =>
      `The next new session will read ${tokens(used)} of its ${tokens(budget)}.`,
    group: {
      always: () => "Always",
      here: ({ camp }: { readonly camp: boolean }) => (camp ? "This camp" : "This chat"),
      carried: () => "Carried",
      archived: () => "Archived",
    } satisfies Record<FocusGroup, (where: { readonly camp: boolean }) => string>,
    archived: "Your earlier chat",
    archivedNote: "Not read. Find still searches it.",
    part: {
      "memory-brief": ({ name }: Named) => `${name}'s memory and your preferences`,
      "camp-brief": () => "The camp's brief",
      decisions: () => "Active decisions",
      "open-work": () => "Open work",
      carried: () => "Items carried over",
      artifacts: () => "What was made here",
      chapters: () => "Resting chapters, one line each",
      "live-chapter": () => "The live chapter, word for word",
    } satisfies Record<PackPartName, (named: Named) => string>,
    size: ({ count }: Counted) => tokens(count),
    /** What a part left out to fit its share, in its own items. */
    trimmed: ({
      full,
      titlesOnly,
      leftOut,
    }: {
      readonly full: number;
      readonly titlesOnly: number;
      readonly leftOut: number;
    }) =>
      titlesOnly > 0
        ? `Trimmed to fit: ${formatCount(full)} in full, ${formatCount(titlesOnly)} by title, ${formatCount(leftOut)} left out.`
        : `Trimmed to fit: ${formatCount(leftOut)} left out.`,
    cut: ({ count }: Counted) =>
      plural(count, {
        one: "1 character cut from the middle of a long message.",
        other: `${formatCount(count)} characters cut from the middle of a long message.`,
      }),
    footer: ({ name }: Named) =>
      `When you change topic, ${name} starts a new chapter and a fresh session. A resting topic costs one line, so a long chat stays as light as a new one.`,
    loading: ({ name }: Named) => `Checking what ${name} reads…`,
    failed: ({ name }: Named) => `Couldn't check what ${name} reads. Hobbots may be reconnecting.`,
    retry: "Check again",
    close: "Close",
  },
};
