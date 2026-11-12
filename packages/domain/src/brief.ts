import { Schema } from "effect";
import { Actor } from "./actor.ts";
import { ThreadId } from "./ids.ts";
import { Revision } from "./revision.ts";

/**
 * A chat's or camp's brief (ADR 037, Records): a short "Where we are" the hub writes itself, so it
 * costs no hob turn and keeps up while a hob is paused. One per thread, rewritten by the brief
 * projector at chapter ends and Quest steps, on the hub's brain or, under No AI, from the thread's
 * decisions and artifacts. A turn's context pack carries it, and the camp sheet shows it.
 *
 * A brief has no lifecycle of its own: it is written, then written again. What a rewrite may do is
 * the pure rule `briefChange`.
 */

/** Who chose a brief's words: the hub's brain, or the projector's own rule. */
export const BriefSource = Schema.Literals(["brain", "rule"]);
export type BriefSource = typeof BriefSource.Type;

export class Brief extends Schema.Class<Brief>("Brief")({
  threadId: ThreadId,
  /**
   * What the brief says, already cut at its share of the context pack. Empty once nothing it said
   * holds any more, such as when the last decision of a plain brief was crossed out: the pack then
   * carries no brief.
   */
  text: Schema.String,
  /** The hub, which writes every brief. */
  writtenBy: Actor,
  source: BriefSource,
  /** The journal sequence the projector had read through when it wrote this text. */
  basis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  writtenAt: Schema.String,
  revision: Revision,
}) {}

/**
 * A brief the projector would write; an empty `text` says there is nothing to brief on. `source` is
 * `fallback` when the hub's brain was asked and gave no answer that decodes, or none in time: the
 * rule's text, which never replaces a brief the brain wrote.
 */
export interface BriefDraft {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly basis: number;
  readonly source: BriefSource | "fallback";
}

/**
 * What a draft does to the thread's brief:
 * - `write` replaces it, or writes the first one;
 * - `stale` changes nothing, because the stored brief was written from as far along the journal or
 *   further, as when a round replays a page it already wrote;
 * - `kept` changes nothing, because the brain failed and the stored brief is the brain's: it stays
 *   in place rather than a plainer one. A brief the rule wrote is replaced by the rule's new text,
 *   so a crossed-out decision never stays in it;
 * - `unchanged` changes nothing, because the stored brief already says the same, or there is none
 *   and the draft says nothing.
 */
export type BriefChange = "write" | "stale" | "kept" | "unchanged";

export const briefChange = (current: Brief | null, draft: BriefDraft): BriefChange => {
  if (current === null) return draft.text === "" ? "unchanged" : "write";
  if (current.basis >= draft.basis) return "stale";
  if (draft.source === "fallback" && current.source === "brain") return "kept";
  return current.text === draft.text && current.source === briefSourceOf(draft) ? "unchanged" : "write";
};

/** The source a written draft is kept with: a fallback is the rule's text. */
export const briefSourceOf = (draft: BriefDraft): BriefSource => (draft.source === "fallback" ? "rule" : draft.source);
