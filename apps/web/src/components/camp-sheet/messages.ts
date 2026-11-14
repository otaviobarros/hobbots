import {
  type ArtifactContentRefusal,
  DECISION_TEXT_MAX,
  type QuestState,
  type RegisteredArtifactKind,
} from "@hobbots/domain";
import { formatCompact, formatCount, plural } from "../../lib/format.ts";
import type { ArtifactFilter } from "./artifact-rows.ts";
import type { DecisionProblem, RecordDecisionError } from "./decision-flow.ts";

interface Named {
  readonly name: string;
}

interface Counted {
  readonly count: number;
}

/** User-facing copy for a camp's sheet (ADR 037, STD-I18N-001): its brief and records, and what is yours. */
export const messages = {
  open: "This camp",
  /** A decision's or a pin's mark, before its words. */
  mark: "◆",
  openFor: ({ title }: { readonly title: string }) => `This camp, open the sheet for ${title}`,
  eyebrow: ({ name }: Named) => `${name}'s camp`,
  close: "Close the camp sheet",
  tabs: {
    overview: "Overview",
    decisions: "Decisions",
    artifacts: "Artifacts",
    mine: "Mine",
  },
  /** A tab's count, beside its name, shortened once large ("1.2K") so the tabs keep fitting the sheet. */
  count: ({ count }: Counted) => formatCompact(count),
  readFailed: "Couldn't read this. Hobbots may be reconnecting.",
  retry: "Read again",
  overview: {
    whereWeAre: "Where we are",
    briefNote: ({ name }: Named) => `${name} rewrites this at each quest step, from the records.`,
    noBrief: ({ name }: Named) => `Nothing here yet. ${name} writes this once a chapter ends or a quest takes a step.`,
    quests: "Quests",
    noQuests: "No quests started here yet.",
    needsYou: ({ count }: Counted) => plural(count, { one: "Needs you", other: `${formatCount(count)} need you` }),
    done: ({ done, total }: { readonly done: number; readonly total: number }) =>
      `${formatCount(done)} of ${formatCount(total)} done`,
    questState: {
      active: "Under way",
      paused: "Paused",
      completed: "Done",
      failed: "Failed",
      cancelled: "Cancelled",
      stopping: "Stopping",
      stopped: "Stopped at your request",
    } satisfies Record<QuestState, string>,
    chapters: "Chapters",
    live: "Live",
    resting: "Resting",
    untitled: ({ number }: { readonly number: number }) => `Chapter ${formatCount(number)}`,
    settings: "Camp settings",
    private: "Private camp",
    privateOn: ({ name }: Named) =>
      `Nothing said here from now on goes into ${name}'s memory. What was captured before stays.`,
    privateOff: ({ name }: Named) =>
      `What ${name} learns here can go into memory. If you make it private, what was captured before stays.`,
    privateFailed: "Couldn't change this. Hobbots may be reconnecting; try again in a moment.",
  },
  decisions: {
    newestFirst: "Newest first",
    empty: "No decisions yet.",
    add: "Add a decision",
    change: "Change",
    changeOf: ({ text }: { readonly text: string }) => `Change “${text}”`,
    crossOut: "Cross out",
    crossOutOf: ({ text }: { readonly text: string }) => `Cross out “${text}”`,
    crossing: "Crossing out…",
    changedTo: ({ text }: { readonly text: string }) => `Changed to ${text}`,
    crossedOut: "Crossed out",
    byYou: "You",
    byline: ({ who, when }: { readonly who: string; readonly when: string }) => `${who} · ${when}`,
    field: "Decision",
    replacing: ({ text }: { readonly text: string }) => `Replaces “${text}”, which stays crossed out.`,
    placeholder: "What did you decide?",
    save: "Save the decision",
    saving: "Saving…",
    cancel: "Cancel",
    tryAgain: "Try again",
    footnote:
      "Saved when you answer a question or a hob confirms what you agreed. A changed decision stays, crossed out.",
    problems: {
      "text-missing": "Write the decision.",
      "text-long": `Keep it to ${formatCount(DECISION_TEXT_MAX)} characters.`,
    } satisfies Record<DecisionProblem, string>,
    errors: {
      refused: "Couldn't save it: the decision changed meanwhile, or this chat is archived.",
      unreachable: "Couldn't save it. Hobbots may be reconnecting; try again in a moment.",
    } satisfies Record<RecordDecisionError, string>,
    crossFailed: "Couldn't cross it out. Hobbots may be reconnecting; try again in a moment.",
  },
  artifacts: {
    filters: {
      all: "All",
      code: "Code",
      pages: "Pages",
      docs: "Docs",
      images: "Images",
    } satisfies Record<ArtifactFilter, string>,
    filterLabel: "Show artifacts",
    empty: "Nothing made here yet.",
    kind: {
      code: "Code",
      page: "Page",
      doc: "Doc",
      email: "Email",
      image: "Image",
      pr: "Pull request",
      file: "File",
    } satisfies Record<RegisteredArtifactKind, string>,
    meta: ({ kind, version, when }: { readonly kind: string; readonly version: number; readonly when: string }) =>
      version > 1 ? `${kind} · version ${formatCount(version)} · ${when}` : `${kind} · ${when}`,
    open: "Open",
    openOf: ({ title }: { readonly title: string }) => `Open ${title}`,
    back: "Back to artifacts",
    where: "Where it is",
    you: "You",
    openLink: "Open the link",
    jump: "Show where it was made",
    footnote: "One row per artifact at its latest version. Older versions live inside it.",
    versions: "Versions",
    versionChip: ({ version }: { readonly version: number }) => `v${formatCount(version)}`,
    versionName: ({
      version,
      when,
      latest,
    }: {
      readonly version: number;
      readonly when: string;
      readonly latest: boolean;
    }) => (latest ? `v${formatCount(version)}, the latest, ${when}` : `v${formatCount(version)}, ${when}`),
    showing: ({ version, total }: { readonly version: number; readonly total: number }) =>
      `Version ${formatCount(version)} of ${formatCount(total)}`,
    comparedWith: ({ version }: { readonly version: number }) => `Changes since version ${formatCount(version)}`,
    fullView: "Full view",
    fullViewOf: ({ title }: { readonly title: string }) => `Full view of ${title}`,
    closeFull: "Close the full view",
    preview: ({ title }: { readonly title: string }) => `A preview of ${title}`,
    pageOf: ({ title }: { readonly title: string }) => `The page ${title}, without its scripts`,
    imageOf: ({ title, version }: { readonly title: string; readonly version: number }) =>
      `${title}, version ${formatCount(version)}`,
    rendered: "Rendered",
    source: "Source",
    showAs: "Show as",
    reading: "Reading it…",
    readAgain: "Read again",
    unread: "Couldn't read this version. Hobbots may be reconnecting.",
    linkNote: "A link. It opens in your browser.",
    cannotShow: "Hobbots can't show this kind of file here.",
    unavailable: {
      "not-kept": "Hobbots didn't keep this version. Only the latest one is read from the file now.",
      "outside-folders": "This file is outside the hob's folders now, so Hobbots doesn't read it.",
      secret: "Its name marks it as one that may hold secrets, so Hobbots doesn't show it.",
      "too-large": "It's too large to show here.",
      gone: "The file isn't there any more.",
      "no-contents": "Hobbots can't show this kind of file here.",
      "not-found": "This version isn't here any more.",
    } satisfies Record<ArtifactContentRefusal | "not-found", string>,
    review: {
      label: "Review",
      toReview: "To review",
      waiting: "Waiting for you",
      reviewed: ({ who, when }: { readonly who: string; readonly when: string }) => `Reviewed by ${who} · ${when}`,
      dismissed: ({ who, when }: { readonly who: string; readonly when: string }) => `Dismissed by ${who} · ${when}`,
      you: "you",
      github: "GitHub",
      hub: "Hobbots",
      markReviewed: "Mark reviewed",
      dismiss: "Dismiss",
      saving: "Saving…",
      refused: "This was already settled the other way, so it stays as it was.",
      unreachable: "Couldn't save this. Hobbots may be reconnecting; try again in a moment.",
    },
  },
  mine: {
    pinned: "Pinned",
    noPins: "Pin a message from its ⋯ menu to find it here.",
    notes: "Notes to self",
    noNotes: "Write a note to self from the composer. Only you read it.",
    note: "Notes never wake a hob, and no hob reads them.",
    jump: "Show in the chat",
    jumpTo: ({ text }: { readonly text: string }) => `Show “${text}” in the chat`,
    unpin: "Unpin",
  },
};
