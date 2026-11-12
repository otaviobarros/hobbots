import { CAMP_GOAL_MAX, type CarriedOverRef, THREAD_TITLE_MAX } from "@hobbots/domain";
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
    lead: ({ name }: Named) =>
      `A camp holds one goal. ${name} keeps going there while the goal stays the same, and your chat stays for everything else.`,
    name: "Name",
    namePlaceholder: "What is this camp called?",
    goal: "Goal",
    goalPlaceholder: "What is this camp for?",
    goalHint: ({ name }: Named) => `${name} uses the goal to notice when something belongs here.`,
    comesAlong: "Comes along",
    memory: ({ name }: Named) => `${name}'s memory`,
    memoryAlways: "What they know about you. Always comes along.",
    private: "Private camp",
    privateOn: ({ name }: Named) =>
      `Nothing said here goes into ${name}'s memory. ${name} still uses what they already know.`,
    privateOff: ({ name }: Named) => `What ${name} learns here can go into memory, like anywhere else.`,
    cancel: "Cancel",
    make: "Make the camp",
    making: "Making the camp…",
    problems: {
      "title-missing": "Give the camp a name.",
      "title-long": `Keep the name to ${formatCount(THREAD_TITLE_MAX)} characters.`,
      "goal-long": `Keep the goal to ${formatCount(CAMP_GOAL_MAX)} characters.`,
    } satisfies Record<CampProblem, string>,
    errors: {
      "hob-unavailable": ({ name }: Named) => `${name} is paused or retired, so it can't take a new camp now.`,
      unreachable: () => "Couldn't make the camp. Hobbots may be reconnecting; try again in a moment.",
    } satisfies Record<MakeCampError, (named: Named) => string>,
    made: ({ title }: { readonly title: string }) => `${title} is now a camp.`,
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
