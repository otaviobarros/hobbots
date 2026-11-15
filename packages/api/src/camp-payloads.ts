import { AgentId, CAMP_GOAL_MAX, CHANNEL_TITLE_MAX, ChannelId } from "@hobbots/domain";
import { Schema } from "effect";

/**
 * The key of Make a camp or Start fresh: the command's idempotency key, which becomes the new
 * channel's id, so sending the same request again changes nothing.
 */
export const ChannelKey = ChannelId.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100));

/** The most hobs a camp is made with beside the one that leads it. */
export const CAMP_HOBS_MAX = 24;

/**
 * A camp to make for a hob (ADR 037): its title, its goal, if any, and whether it is private. `hobs`
 * are the other hobs it is made with (ADR 039, Members); the hob it is made for leads its quests.
 */
export const MakeCampPayload = Schema.Struct({
  key: ChannelKey,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(CHANNEL_TITLE_MAX)),
  goal: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(CAMP_GOAL_MAX))),
  private: Schema.Boolean,
  hobs: Schema.optionalKey(Schema.Array(AgentId).check(Schema.isMaxLength(CAMP_HOBS_MAX))),
});
export type MakeCampPayload = typeof MakeCampPayload.Type;
