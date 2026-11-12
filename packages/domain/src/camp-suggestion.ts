import { Schema } from "effect";
import { type Chapter, ChapterStates } from "./chapter.ts";
import { ChapterId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";

/**
 * Camp suggestions (ADR 037, Records): when a topic in the chat grows, the hub suggests making it a
 * camp, and moving its chapter there. A pure rule raises one in the transaction that grew the
 * chapter, from named thresholds, and the hub's brain may raise one for a chapter that drifted into
 * its own topic. A chapter gets at most one suggestion, so one you kept in the chat never comes back.
 */

export const CampSuggestionId = Schema.String.pipe(Schema.brand("CampSuggestionId"));
export type CampSuggestionId = typeof CampSuggestionId.Type;

/** Where a suggestion stands, held by `CampSuggestionStateMachine`. */
export const SuggestionState = Schema.Literals(["open", "kept", "accepted", "expired"]);
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
  threadId: ThreadId,
  chapterId: ChapterId,
  /** Why it was raised, as codes and counts, never as text, so every client words it its own way. */
  reasons: Schema.Array(CampSuggestionReason),
  /** Only `CampSuggestionStateMachine` changes it, and code outside reads it through `CampSuggestions`. */
  state: SuggestionState,
  raisedAt: Schema.String,
  /** When it was kept, accepted or expired, or null while it is open. */
  settledAt: Schema.NullOr(Schema.String),
  /** The camp its chapter moved into, once accepted; null otherwise. */
  campId: Schema.NullOr(ThreadId),
  revision: Revision,
}) {}

/** What can happen to a suggestion. */
export type CampSuggestionEvent =
  /** You chose Keep in chat: the chapter stays, and it is never suggested again. */
  | { readonly _tag: "Keep"; readonly at: string }
  /** The chapter moved into `campId`, whichever way it was asked. */
  | { readonly _tag: "Accept"; readonly at: string; readonly campId: ThreadId }
  /** It no longer applies: its chapter was merged away, or its chat closed. */
  | { readonly _tag: "Expire"; readonly at: string };

/** A change to a suggestion its state does not allow. */
export class IllegalSuggestionTransition extends Schema.TaggedError<IllegalSuggestionTransition>()(
  "IllegalSuggestionTransition",
  { suggestionId: CampSuggestionId, from: SuggestionState, to: SuggestionState },
) {}

/** A suggestion's lifecycle (ADR 037), declared once. Only an open one changes, and only once. */
export const CampSuggestionStateMachine = defineMachine<
  SuggestionState,
  CampSuggestionEvent,
  CampSuggestion,
  IllegalSuggestionTransition
>({
  name: "CampSuggestionState",
  states: {
    open: "Offered in the chat, with Make a camp and Keep in chat",
    kept: "You kept the chapter in the chat; it is never offered again",
    accepted: "The chapter moved into a camp",
    expired: "Its chapter was merged away or its chat closed, so it is no longer offered",
  },
  field: "state",
  events: {
    Keep: {
      from: ["open"],
      to: "kept",
      apply: (suggestion, e) => new CampSuggestion({ ...suggestion, state: "kept", settledAt: e.at }),
    },
    // The camp is never the chat it was offered in.
    Accept: {
      from: ["open"],
      to: "accepted",
      guard: (suggestion, e) => e.campId !== suggestion.threadId,
      apply: (suggestion, e) =>
        new CampSuggestion({ ...suggestion, state: "accepted", settledAt: e.at, campId: e.campId }),
    },
    Expire: {
      from: ["open"],
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
  /** The thread the chapter is in, and whether it is its hob's open chat. */
  readonly thread: { readonly id: ThreadId; readonly openChat: boolean };
  readonly chapter: Chapter;
  /** Whether the chapter has a suggestion already, in any state. */
  readonly suggested: boolean;
  readonly reasons: ReadonlyArray<CampSuggestionReason>;
  readonly id: CampSuggestionId;
  readonly at: string;
}

/**
 * The pure rule of raising a suggestion (ADR 037): only in an open chat, only for a chapter still in
 * it, at most once per chapter, and only with a reason. Null when it raises none.
 */
export const planCampSuggestion = (facts: SuggestionFacts): CampSuggestion | null => {
  if (!facts.thread.openChat) return null;
  if (facts.chapter.threadId !== facts.thread.id || !ChapterStates.isInThread(facts.chapter)) return null;
  if (facts.suggested || facts.reasons.length === 0) return null;
  return new CampSuggestion({
    id: facts.id,
    threadId: facts.thread.id,
    chapterId: facts.chapter.id,
    reasons: facts.reasons,
    state: "open",
    raisedAt: facts.at,
    settledAt: null,
    campId: null,
  });
};

/**
 * Why Keep in chat changed nothing. `not-found`: the suggestion is not in this chat. `settled`: it
 * was accepted or expired, so there is nothing to keep.
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
  if (suggestion === null) return new CampSuggestionRefused({ suggestionId: id, reason: "not-found" });
  const kept = CampSuggestions.transition(suggestion, { _tag: "Keep", at });
  if (kept instanceof CampSuggestion) return { kept, changed: true };
  return suggestion.state === "kept"
    ? { kept: suggestion, changed: false }
    : new CampSuggestionRefused({ suggestionId: id, reason: "settled" });
};
