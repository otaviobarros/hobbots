import { Schema } from "effect";
import { AgentId } from "./ids.ts";

/**
 * The hub tool call behind a change a hob made or proposed, by the key it sent in its work (ADR 031):
 * `scope` is the work the key belongs to, such as `task:<Task id>`.
 */
export const ChangeCall = Schema.Struct({ scope: Schema.String, key: Schema.String });
export type ChangeCall = typeof ChangeCall.Type;

/** You made the change, in the app or through the API. */
const You = Schema.TaggedStruct("You", {});
/** You made it by applying a hob's proposal: the hob that proposed it, the proposal and the call behind it. */
const YouApplyingProposal = Schema.TaggedStruct("YouApplyingProposal", {
  hobId: AgentId,
  proposalId: Schema.String,
  call: ChangeCall,
});
/** A hob made it on its own, under an Allow, with the call it made. */
const Hob = Schema.TaggedStruct("Hob", { hobId: AgentId, call: ChangeCall });

/**
 * Who made a change to a hob (ADR 034): its creation, each configuration version, and each pause,
 * wake, retirement and return. Only you could change a hob before this was recorded, so a record
 * without one reads as you.
 */
export const ChangeActor = Schema.Union([You, YouApplyingProposal, Hob]);
export type ChangeActor = typeof ChangeActor.Type;

export const YOU: ChangeActor = { _tag: "You" };

/** The hob behind a change: the one that made it or proposed it, or null when it was yours alone. */
export const hobBehind = (actor: ChangeActor): AgentId | null => (actor._tag === "You" ? null : actor.hobId);
