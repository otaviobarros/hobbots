import { Effect, Schema } from "effect";
import { type Chapter, ChapterStates, oneLineUpTo } from "./chapter.ts";
import { ChapterId, ChannelId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import { CAMP_GOAL_MAX, CHANNEL_TITLE_MAX } from "./channel.ts";

/**
 * Camp suggestions (ADR 037, Records): when a topic in the chat grows, the hub suggests making it a
 * camp, and moving its chapter there. A pure rule raises one in the transaction that grew the
 * chapter, from named thresholds, and the hub's brain may raise one for a chapter that drifted into
 * its own topic. A chapter gets at most one suggestion, so one you kept in the chat never comes back.
 *
 * A suggestion is raised `pending` (#1557): before it is offered, the hub checks that its chapter
 * holds one topic and names the camp it would make. A chapter that holds several topics is never
 * offered whole: the hub splits off its last topic, which may be suggested on its own.
 */

export const CampSuggestionId = Schema.String.pipe(Schema.brand("CampSuggestionId"));
export type CampSuggestionId = typeof CampSuggestionId.Type;

/** Where a suggestion stands, held by `CampSuggestionStateMachine`. */
export const SuggestionState = Schema.Literals(["pending", "open", "kept", "accepted", "expired"]);
export type SuggestionState = typeof SuggestionState.Type;

/** The decisions a chat chapter records before the hub suggests a camp for it. */
export const CAMP_SUGGESTION_DECISIONS = 5;
/** The artifacts a chat chapter makes or changes before the hub suggests a camp for it. */
export const CAMP_SUGGESTION_ARTIFACTS = 4;
/** The quests a chat chapter starts before the hub suggests a camp for it. */
export const CAMP_SUGGESTION_QUESTS = 2;
/** The messages a chat chapter holds before the hub suggests a camp for it. */
export const CAMP_SUGGESTION_MESSAGES = 80;
/** How sure the hub's brain must be, from 0 to 1, that a chapter drifted into its own topic. */
export const CAMP_DRIFT_CONFIDENCE = 0.7;

/** The name a suggestion offers for its camp: one line, as long as a channel's title; null when it has no text. */
export const suggestedCampTitle = (title: string): string | null => oneLineUpTo(title, CHANNEL_TITLE_MAX);

/** The goal a suggestion offers for its camp: one line, as long as a camp's goal; null when it has no text. */
export const suggestedCampGoal = (goal: string): string | null => oneLineUpTo(goal, CAMP_GOAL_MAX);

/**
 * Why a suggestion was raised: a threshold the chapter reached, or `drift`, the hub's brain judging
 * that the chapter drifted into a topic of its own.
 */
export const CampSuggestionCode = Schema.Literals(["decisions", "artifacts", "quests", "length", "drift"]);
export type CampSuggestionCode = typeof CampSuggestionCode.Type;

/** One reason, with its count: the decisions, artifacts, quests or messages the chapter held. */
export const CampSuggestionReason = Schema.Struct({ code: CampSuggestionCode, count: Schema.Int });
export type CampSuggestionReason = typeof CampSuggestionReason.Type;

export class CampSuggestion extends Schema.Class<CampSuggestion>("CampSuggestion")({
  id: CampSuggestionId,
  /** The chat it is offered in, and the chapter it would move. */
  channelId: ChannelId,
  chapterId: ChapterId,
  /** Why it was raised, as codes and counts, never as text, so every client words it its own way. */
  reasons: Schema.Array(CampSuggestionReason),
  /**
   * The camp's name and one-line goal the hub suggests, which Make a camp prefills (#1557): the hub's
   * brain draws them from the chapter's topic; under No AI the name is the chapter's own title and
   * there is no goal. Null while pending, and for a suggestion raised before they were.
   */
  title: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  goal: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Only `CampSuggestionStateMachine` changes it, and code outside reads it through `CampSuggestions`. */
  state: SuggestionState,
  raisedAt: Schema.String,
  /** When it was kept, accepted or expired, or null while it is open. */
  settledAt: Schema.NullOr(Schema.String),
  /** The camp its chapter moved into, once accepted; null otherwise. */
  campId: Schema.NullOr(ChannelId),
  revision: Revision,
}) {}

/** What can happen to a suggestion. */
export type CampSuggestionEvent =
  /** The hub found the chapter holds one topic, and offers it with the camp's name and goal. */
  | { readonly _tag: "Offer"; readonly title: string | null; readonly goal: string | null }
  /** The hub found the chapter holds several topics, so it is never offered whole. */
  | { readonly _tag: "Withdraw"; readonly at: string }
  /** You chose Keep in chat: the chapter stays, and it is never suggested again. */
  | { readonly _tag: "Keep"; readonly at: string }
  /** The chapter moved into `campId`, whichever way it was asked, offered or not. */
  | { readonly _tag: "Accept"; readonly at: string; readonly campId: ChannelId }
  /** It no longer applies: its chapter was merged away, or its chat closed. */
  | { readonly _tag: "Expire"; readonly at: string };

/** A change to a suggestion its state does not allow. */
export class IllegalSuggestionTransition extends Schema.TaggedError<IllegalSuggestionTransition>()(
  "IllegalSuggestionTransition",
  { suggestionId: CampSuggestionId, from: SuggestionState, to: SuggestionState },
) {}

/**
 * A suggestion's lifecycle (ADR 037), declared once. A pending one is offered or withdrawn; an open
 * one is kept, accepted or expired, once.
 */
export const CampSuggestionStateMachine = defineMachine<
  SuggestionState,
  CampSuggestionEvent,
  CampSuggestion,
  IllegalSuggestionTransition
>({
  name: "CampSuggestionState",
  states: {
    pending: "Raised; the hub checks its chapter holds one topic and names the camp before offering it",
    open: "Offered in the chat, with Make a camp and Keep in chat",
    kept: "You kept the chapter in the chat; it is never offered again",
    accepted: "The chapter moved into a camp",
    expired: "Its chapter holds several topics, was merged away, or its chat closed, so it is not offered",
  },
  field: "state",
  events: {
    Offer: {
      from: ["pending"],
      to: "open",
      apply: (suggestion, e) => new CampSuggestion({ ...suggestion, state: "open", title: e.title, goal: e.goal }),
    },
    Withdraw: {
      from: ["pending"],
      to: "expired",
      apply: (suggestion, e) => new CampSuggestion({ ...suggestion, state: "expired", settledAt: e.at }),
    },
    Keep: {
      from: ["open"],
      to: "kept",
      apply: (suggestion, e) => new CampSuggestion({ ...suggestion, state: "kept", settledAt: e.at }),
    },
    // The camp is never the chat it was offered in.
    Accept: {
      from: ["pending", "open"],
      to: "accepted",
      guard: (suggestion, e) => e.campId !== suggestion.channelId,
      apply: (suggestion, e) =>
        new CampSuggestion({ ...suggestion, state: "accepted", settledAt: e.at, campId: e.campId }),
    },
    Expire: {
      from: ["pending", "open"],
      to: "expired",
      apply: (suggestion, e) => new CampSuggestion({ ...suggestion, state: "expired", settledAt: e.at }),
    },
  },
  illegal: (suggestion, _, to) =>
    new IllegalSuggestionTransition({ suggestionId: suggestion.id, from: suggestion.state, to }),
});

/** `CampSuggestionStateMachine` with the questions code outside this module asks of a suggestion's state. */
export const CampSuggestions = {
  ...CampSuggestionStateMachine,
  isOpen: (suggestion: CampSuggestion): boolean => suggestion.state === "open",
  isPending: (suggestion: CampSuggestion): boolean => suggestion.state === "pending",
  /** Whether it is still to be settled: pending, or offered. */
  isUnsettled: (suggestion: CampSuggestion): boolean => suggestion.state === "pending" || suggestion.state === "open",
};

/** What a chapter holds, as the suggestion rule weighs it. */
export interface ChapterCounts {
  readonly decisions: number;
  readonly artifacts: number;
  readonly quests: number;
  readonly messages: number;
}

/** The thresholds, by the code a chapter that reaches one is suggested with. */
const THRESHOLDS: ReadonlyArray<{
  readonly code: CampSuggestionCode;
  readonly of: keyof ChapterCounts;
  readonly at: number;
}> = [
  { code: "decisions", of: "decisions", at: CAMP_SUGGESTION_DECISIONS },
  { code: "artifacts", of: "artifacts", at: CAMP_SUGGESTION_ARTIFACTS },
  { code: "quests", of: "quests", at: CAMP_SUGGESTION_QUESTS },
  { code: "length", of: "messages", at: CAMP_SUGGESTION_MESSAGES },
];

/** The thresholds a chapter's counts reach, each with its count, in a fixed order; empty when none. */
export const campSuggestionReasons = (counts: ChapterCounts): ReadonlyArray<CampSuggestionReason> =>
  THRESHOLDS.filter((threshold) => counts[threshold.of] >= threshold.at).map((threshold) => ({
    code: threshold.code,
    count: counts[threshold.of],
  }));

/** What the rule reads of a chapter, in the transaction that may raise its suggestion. */
export interface SuggestionFacts {
  /** The channel the chapter is in, and whether it is its hob's open chat. */
  readonly channel: { readonly id: ChannelId; readonly openChat: boolean };
  readonly chapter: Chapter;
  /** Whether the chapter has a suggestion already, in any state. */
  readonly suggested: boolean;
  readonly reasons: ReadonlyArray<CampSuggestionReason>;
  readonly id: CampSuggestionId;
  readonly at: string;
}

/**
 * The pure rule of raising a suggestion (ADR 037): only in an open chat, only for a chapter still in
 * it, at most once per chapter, and only with a reason. It is raised pending, to be named and
 * checked for one topic before it is offered (#1557). Null when it raises none.
 */
export const planCampSuggestion = (facts: SuggestionFacts): CampSuggestion | null => {
  if (!facts.channel.openChat) return null;
  if (facts.chapter.channelId !== facts.channel.id || !ChapterStates.isInChannel(facts.chapter)) return null;
  if (facts.suggested || facts.reasons.length === 0) return null;
  return new CampSuggestion({
    id: facts.id,
    channelId: facts.channel.id,
    chapterId: facts.chapter.id,
    reasons: facts.reasons,
    title: null,
    goal: null,
    state: "pending",
    raisedAt: facts.at,
    settledAt: null,
    campId: null,
  });
};

/**
 * Why Keep in chat changed nothing. `not-found`: the suggestion is not in this chat, or not offered
 * yet. `settled`: it was accepted or expired, so there is nothing to keep.
 */
export const CampSuggestionRefusal = Schema.Literals(["not-found", "settled"]);
export type CampSuggestionRefusal = typeof CampSuggestionRefusal.Type;

export class CampSuggestionRefused extends Schema.TaggedError<CampSuggestionRefused>()("CampSuggestionRefused", {
  suggestionId: CampSuggestionId,
  reason: CampSuggestionRefusal,
}) {}

/**
 * The pure rule of Keep in chat: an open suggestion is kept; one kept already is answered as it is,
 * so Keep sent again changes nothing; one accepted or expired is refused.
 */
export const planKeep = (
  id: CampSuggestionId,
  suggestion: CampSuggestion | null,
  at: string,
): { readonly kept: CampSuggestion; readonly changed: boolean } | CampSuggestionRefused => {
  if (suggestion === null || CampSuggestions.isPending(suggestion)) {
    return new CampSuggestionRefused({ suggestionId: id, reason: "not-found" });
  }
  const kept = CampSuggestions.transition(suggestion, { _tag: "Keep", at });
  if (kept instanceof CampSuggestion) return { kept, changed: true };
  return suggestion.state === "kept"
    ? { kept: suggestion, changed: false }
    : new CampSuggestionRefused({ suggestionId: id, reason: "settled" });
};
