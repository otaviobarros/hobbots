import { CAMP_GOAL_MAX, THREAD_TITLE_MAX, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";

/**
 * The key of Make a camp or Start fresh: the command's idempotency key, which becomes the new
 * thread's id, so sending the same request again changes nothing.
 */
export const ThreadKey = ThreadId.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100));

/** A camp to make for a hob (ADR 037): its title, its goal, if any, and whether it is private. */
export const MakeCampPayload = Schema.Struct({
  key: ThreadKey,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(THREAD_TITLE_MAX)),
  goal: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(CAMP_GOAL_MAX))),
  private: Schema.Boolean,
});
export type MakeCampPayload = typeof MakeCampPayload.Type;
