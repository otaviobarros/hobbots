import { Schema } from "effect";
import { MessageId } from "./ids.ts";
import { MemoryPath, MemoryScope } from "./memory.ts";

/**
 * The parts of a context pack (ADR 037), in the order a session reads them. The memory brief is
 * sent beside the pack, as ADR 028 sends it, and counts against the pack's budget. `members` says
 * who is in the channel and why the turn runs (ADR 039, The context pack with several hobs).
 */
export const PackPartName = Schema.Literals([
  "memory-brief",
  "members",
  "camp-brief",
  "decisions",
  "open-work",
  "carried",
  "artifacts",
  "chapters",
  "live-chapter",
]);
export type PackPartName = typeof PackPartName.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * What the pack left out of a part, counted in the part's own items: decisions, open work, carried
 * items, artifacts, chapters or messages. `full` were kept whole, `titlesOnly` by title alone
 * (decisions), `leftOut` only counted, and `cutCharacters` cut from the middle of the last message.
 */
export const PackTrim = Schema.Struct({
  full: Count,
  titlesOnly: Count,
  leftOut: Count,
  cutCharacters: Count,
});
export type PackTrim = typeof PackTrim.Type;

/** One part of a pack: its share of the budget and its size, in tokens, and what it trimmed, or null. */
export const PackPart = Schema.Struct({
  part: PackPartName,
  share: Count,
  tokens: Count,
  trimmed: Schema.NullOr(PackTrim),
});
export type PackPart = typeof PackPart.Type;

/**
 * One record a pack carried, which a hob's reply lists as "Read first" (ADR 039, Asking for a
 * delivery in a shared camp). Each one opens: a memory page in Memory, and a decision, an artifact or
 * an earlier chapter at the message it was made in, when there is one.
 */
export const PackRead = Schema.Union([
  /** A page of the hob's memory brief, by the scope and path Memory opens it at. */
  Schema.TaggedStruct("MemoryPage", { scope: MemoryScope, path: MemoryPath, title: Schema.String }),
  /** An active decision, by its title, and the message whose turn recorded it, or null. */
  Schema.TaggedStruct("Decision", { id: Schema.String, title: Schema.String, messageId: Schema.NullOr(MessageId) }),
  /** An artifact at the version the pack listed, and the message that made that version, or null. */
  Schema.TaggedStruct("Artifact", {
    id: Schema.String,
    kind: Schema.String,
    title: Schema.String,
    version: Count,
    messageId: Schema.NullOr(MessageId),
  }),
  /** An earlier chapter's line, and its first message, or null when none is left in the channel. */
  Schema.TaggedStruct("Chapter", {
    number: Count,
    title: Schema.NullOr(Schema.String),
    messageId: Schema.NullOr(MessageId),
  }),
]);
export type PackRead = typeof PackRead.Type;

/** The most records a pack lists as read, in its parts' order: memory, decisions, artifacts, chapters. */
export const PACK_READ_MAX = 12;

/**
 * What a turn's context pack holds (ADR 037): each part with its size in tokens and what it
 * trimmed, and the records it carried. Logged per turn, and what the Focus chip shows.
 */
export const PackReport = Schema.Struct({
  /** The pack's budget in tokens; `tokens` never goes over it. */
  budget: Count,
  tokens: Count,
  parts: Schema.Array(PackPart),
  /** The records the pack carried whole or by title, at most `PACK_READ_MAX`; none it only counted. */
  read: Schema.Array(PackRead),
});
export type PackReport = typeof PackReport.Type;
