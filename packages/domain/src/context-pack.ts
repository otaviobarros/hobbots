import { Schema } from "effect";

/**
 * The parts of a context pack (ADR 037), in the order a session reads them. The memory brief is
 * sent beside the pack, as ADR 028 sends it, and counts against the pack's budget. `members` says
 * who is in the thread and why the turn runs (ADR 039, The context pack with several hobs).
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
 * What a turn's context pack holds (ADR 037): each part with its size in tokens and what it
 * trimmed. Logged per turn, and what the Focus chip shows.
 */
export const PackReport = Schema.Struct({
  /** The pack's budget in tokens; `tokens` never goes over it. */
  budget: Count,
  tokens: Count,
  parts: Schema.Array(PackPart),
});
export type PackReport = typeof PackReport.Type;
