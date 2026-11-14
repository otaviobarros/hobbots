import { CAMP_HOBS_MAX } from "@hobbots/api";
import { CAMP_GOAL_MAX, type CampSuggestionCode, type CarriedOverRef, THREAD_TITLE_MAX } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import type { CampProblem, MakeCampError } from "./make-camp-flow.ts";
import type { StartFreshError } from "./start-fresh-flow.ts";

interface Named {
  readonly name: string;
}

/** User-facing copy for a hob's chat and camps (STD-I18N-001): the UI says chat and camp, never thread. */
export const messages = {
  sidebar: {
    chat: "Chat",
    /** The hob's chat in the sidebar, with the hob it belongs to. */
    chatOf: ({ name }: Named) => `${name}'s chat`,
    makeCamp: "Make a camp",
    makeCampFor: ({ name }: Named) => `Make a camp for ${name}`,
    camps: ({ name }: Named) => `${name}'s chat and camps`,
  },
  header: {
    /** Under the hob's name in its chat's header, before what it is doing. */
    chatWith: ({ name }: Named) => `Your chat with ${name}`,
    doingLine: ({ doing }: { readonly doing: string }) => ` · ${doing}`,
    /** A camp's mark, before its hob's tile. */
    glyph: "⛺",
    goal: ({ goal }: { readonly goal: string }) => `Goal: ${goal}`,
    camp: "Camp",
    privateCamp: "Private camp",
    placeholder: ({ name }: Named) => `Message ${name}…`,
  },
  menu: {
    makeCamp: "Make a camp",
    startFresh: "Start a fresh chat",
  },
  make: {
    title: "Make a camp",
    lead: "A camp is a place for a goal. Add one hob or several, and other people.",
    name: "Name",
    namePlaceholder: "What is this camp called?",
    goal: "Goal",
    goalPlaceholder: "What is this camp for?",
    private: "Private camp",
    privateDetail: "Nothing said here goes into any hob's memory.",
    cancel: "Cancel",
    make: "Make the camp",
    making: "Making the camp…",
    problems: {
      "title-missing": "Give the camp a name.",
      "title-long": `Keep the name to ${formatCount(THREAD_TITLE_MAX)} characters.`,
      "goal-long": `Keep the goal to ${formatCount(CAMP_GOAL_MAX)} characters.`,
      "hobs-missing": "Pick at least one hob to lead the camp.",
      "hobs-many": `A camp takes up to ${CAMP_HOBS_MAX + 1} hobs. Untick one or more.`,
    } satisfies Record<CampProblem, string>,
    errors: {
      "hob-unavailable": ({ name }: Named) => `${name} is paused or retired, so it can't take a new camp now.`,
      "chapter-busy": ({ name }: Named) =>
        `${name} is still working in this chapter, so it can't move yet. Try again once that ends.`,
      "chapter-refused": () => "Couldn't move that chapter: it changed meanwhile. Try again.",
      unreachable: () => "Couldn't make the camp. Hobbots may be reconnecting; try again in a moment.",
    } satisfies Record<MakeCampError, (named: Named) => string>,
    made: ({ title }: { readonly title: string }) => `${title} is now a camp.`,
    /** Making a camp from a chat's chapter, which moves into it. */
    chapter: ({ title }: { readonly title: string }) => `The ${title} chapter`,
    chapterDetail: ({ from }: { readonly from: string }) => `From your chat: ${from}. It moves into the camp.`,
    chapterLink: "Your chat keeps a link to the camp. Other topics stay in the chat.",
    /** Why the chapter cannot move yet, while Make the camp waits; switching it off makes the camp now. */
    held: ({ name }: Named) =>
      `${name} is still replying here. The chapter can move once the reply ends, or switch it off to make the camp now.`,
  },
  suggestion: {
    eyebrow: ({ name }: Named) => `${name} suggests`,
    heading: ({ title }: { readonly title: string }) => `Make ${title} a camp?`,
    lead: "This topic has grown in your chat. A camp keeps its decisions, files and work together, and your chat stays light.",
    /** Why it was suggested, one chip per reason. */
    reason: {
      decisions: ({ count }: { readonly count: number }) =>
        plural(count, { one: "1 decision", other: `${formatCount(count)} decisions` }),
      artifacts: ({ count }: { readonly count: number }) =>
        plural(count, { one: "1 file", other: `${formatCount(count)} files` }),
      quests: ({ count }: { readonly count: number }) =>
        plural(count, { one: "1 quest", other: `${formatCount(count)} quests` }),
      length: ({ count }: { readonly count: number }) =>
        plural(count, { one: "1 message", other: `${formatCount(count)} messages` }),
      drift: () => "A topic of its own",
    } satisfies Record<CampSuggestionCode, (counted: { readonly count: number }) => string>,
    make: "Make it a camp",
    keep: "Keep it in my chat",
    keeping: "Keeping it…",
    why: "I suggest this when a topic has files, decisions and ongoing work.",
    kept: ({ name, title }: Named & { readonly title: string }) =>
      `✓ Kept in your chat. ${name} won't ask again about ${title}.`,
    keepFailed: "Couldn't keep it in your chat. Hobbots may be reconnecting; try again in a moment.",
    /** On a chat chapter's ⋯ menu. */
    fromChapter: "Make a camp from this chapter",
    messages: ({ count }: { readonly count: number }) =>
      plural(count, { one: "1 message", other: `${formatCount(count)} messages` }),
  },
  fresh: {
    title: ({ name }: Named) => `Start a fresh chat with ${name}`,
    lead: "You don't need to for speed. Do it when you want a clean slate.",
    comesAlong: "Comes along",
    memory: ({ name }: Named) => `${name}'s memory`,
    memoryAlways: "They still know you and your preferences.",
    loading: "Checking what is still open…",
    loadFailed: "Couldn't check what is still open.",
    retryLoad: "Check again",
    /** How many open items move, said before the list of them. */
    count: ({ count }: { readonly count: number }) =>
      count === 0
        ? "Nothing is open, so nothing needs to come along."
        : plural(count, {
            one: "1 open item moves to the new chat, so nothing is dropped.",
            other: `${formatCount(count)} open items move to the new chat, so nothing is dropped.`,
          }),
    kind: {
      task: "Open work",
      question: "A question waiting for an answer",
      reminder: "A reminder",
      "backpack-item": "Still to deal with",
    } satisfies Record<CarriedOverRef["_tag"], string>,
    archiveNote: "This chat goes to the Archive. It stays searchable, and you can read it there.",
    cancel: "Cancel",
    start: "Archive and start fresh",
    starting: "Starting fresh…",
    tryAgain: "Try again",
    errors: {
      "reply-running": ({ name }: Named) => `${name} is still replying. Start fresh once the reply ends.`,
      "approval-pending": ({ name }: Named) => `${name} is waiting for your approval here. Answer it first.`,
      "hob-retired": ({ name }: Named) => `${name} is retired, so this chat stays as it is.`,
      "not-open-chat": () => "This chat was already started fresh or archived.",
      unreachable: () => "Couldn't start fresh. Hobbots may be reconnecting; try again in a moment.",
    } satisfies Record<StartFreshError, (named: Named) => string>,
  },
};
