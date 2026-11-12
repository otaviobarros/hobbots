import { Schema } from "effect";
import { Actor } from "./actor.ts";
import { RegisteredArtifactId, RegisteredArtifactKind } from "./artifact.ts";
import { DecisionId, DecisionState, DecisionStates } from "./decision.ts";
import { AgentId, ChapterId, MessageId, ThreadId } from "./ids.ts";
import { MessageRole } from "./message.ts";
import { SnippetPart } from "./search.ts";
import { ThreadKind } from "./thread.ts";

// Find (ADR 037, Records, #1386): the records of every chat and camp, decisions, artifacts and
// chapters, found by their words beside the messages that say them, in one chat or camp or
// everywhere. Ask answers a question from the records that match it, on the hub's brain, citing
// each one; under No AI it shows the matches without an answer. A private camp is found only from
// inside it.

/** What find looks through. */
export const FindKind = Schema.Literals(["decision", "artifact", "chapter", "message"]);
export type FindKind = typeof FindKind.Type;

/** Every kind, in the order find shows them. */
export const FIND_KINDS: ReadonlyArray<FindKind> = FindKind.literals;

/** The longest search or question find takes. */
export const FIND_QUERY_MAX = 200;

/** Where a found thing is: its chat or camp, the message a citation opens, and its words that matched. */
const place = {
  threadId: ThreadId,
  threadTitle: Schema.String,
  threadKind: ThreadKind,
  hobId: AgentId,
  /** The message it came from, which a citation opens; null when no message made it, such as a Task's file. */
  messageId: Schema.NullOr(MessageId),
  snippet: Schema.Array(SnippetPart),
  /** When it was recorded, last changed, or, for a chapter, started. */
  at: Schema.String,
};

/** A decision that matched: one that holds, or one crossed out, which find still shows, crossed out. */
export const FoundDecision = Schema.TaggedStruct("decision", {
  ...place,
  id: DecisionId,
  text: Schema.String,
  state: DecisionState,
  actor: Actor,
});
export type FoundDecision = typeof FoundDecision.Type;

/** An artifact that matched, at its latest version. */
export const FoundArtifact = Schema.TaggedStruct("artifact", {
  ...place,
  id: RegisteredArtifactId,
  title: Schema.String,
  kind: RegisteredArtifactKind,
  version: Schema.Int,
  actor: Actor,
});
export type FoundArtifact = typeof FoundArtifact.Type;

/** A chapter whose title or summary matched. */
export const FoundChapter = Schema.TaggedStruct("chapter", {
  ...place,
  id: ChapterId,
  number: Schema.Int,
  title: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
});
export type FoundChapter = typeof FoundChapter.Type;

/** A record find found. */
export const FoundRecord = Schema.Union([FoundDecision, FoundArtifact, FoundChapter]);
export type FoundRecord = typeof FoundRecord.Type;

/** A message that matched. */
export const FoundMessage = Schema.TaggedStruct("message", {
  ...place,
  messageId: MessageId,
  role: MessageRole,
  actor: Actor,
});
export type FoundMessage = typeof FoundMessage.Type;

/** What find found: records first, then messages, each newest first. */
export const FindResult = Schema.Struct({
  records: Schema.Array(FoundRecord),
  messages: Schema.Array(FoundMessage),
});
export type FindResult = typeof FindResult.Type;

/**
 * Why Ask shows matches with no answer. `no-ai`: No AI is chosen for the hub's judgments.
 * `no-answer`: the hub's brain was asked and gave no answer that cites the records. `nothing-found`:
 * no record matches the question, so nothing was asked.
 */
export const AskWithoutAnswer = Schema.Literals(["no-ai", "no-answer", "nothing-found"]);
export type AskWithoutAnswer = typeof AskWithoutAnswer.Type;

/**
 * What Ask gives back: the hub's brain's answer and the records it cites, among the matches it
 * read; or the matches alone, and why there is no answer.
 */
export const AskAnswer = Schema.Union([
  Schema.TaggedStruct("Answered", {
    text: Schema.String,
    cites: Schema.Array(FoundRecord),
    matches: Schema.Array(FoundRecord),
  }),
  Schema.TaggedStruct("Matches", { reason: AskWithoutAnswer, matches: Schema.Array(FoundRecord) }),
]);
export type AskAnswer = typeof AskAnswer.Type;

/** Whether a found decision was crossed out: changed or dropped, kept for the record. */
export const isCrossedOut = (found: FoundDecision): boolean => !DecisionStates.holds(found.state);
