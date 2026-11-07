import { Schema } from "effect";
import { AgentId, MessageId, ThreadId } from "./ids.ts";

/**
 * A Charm's write, recorded with its key before anything is sent (ADR 020, ADR 031), so a retried
 * call is never sent twice and a call that ended without a clear result is read back before anything
 * else. The states name GitHub, the first Charm; every Charm's calls move through them the same way.
 *
 * - `sending`: recorded, and being sent or about to be. Found so when the hub starts, the hub stopped
 *   mid-call, so it is uncertain.
 * - `applied`: it took effect, as GitHub answered or as reading GitHub back showed.
 * - `refused`: GitHub answered no, so nothing was done.
 * - `not-sent`: nothing reached GitHub, or the user looked and settled it so. The same key may be
 *   used again, and that call is decided again.
 * - `uncertain`: it may have taken effect. No call of the same action on the same site runs until it
 *   settles, when reading GitHub back finds its effect or the user settles it.
 */
export const CharmCallState = Schema.Literals(["sending", "applied", "refused", "not-sent", "uncertain"]);
export type CharmCallState = typeof CharmCallState.Type;

/** The states a call can no longer leave: anything but sending and uncertain. */
export const isCharmCallSettled = (state: CharmCallState): boolean => state !== "sending" && state !== "uncertain";

export class CharmCall extends Schema.Class<CharmCall>("CharmCall")({
  agentId: AgentId,
  /** The work the key belongs to, such as `task:<Task id>`: a key is unique within it (#660). */
  scope: Schema.String,
  /** The key the hob sent, unique among its calls in that work. */
  key: Schema.String,
  /**
   * This sending of the key: new each time a key that was not sent is used again, so a late outcome
   * of an earlier sending never settles a later one.
   */
  attempt: Schema.String,
  /** The Charm's name as the hub words it, such as `GitHub`, so what the hob and the user are told names it. */
  charm: Schema.String,
  /** The hub tool, such as `github_push`. */
  tool: Schema.String,
  /**
   * The call's input as stable JSON without its key, redacted, so a key sent again with another call
   * is told apart and no secret the hob wrote is stored.
   */
  input: Schema.String,
  /**
   * Where it acts, such as `github.com/owner/name refs/heads/main` for a push. Two writes of the same
   * tool on one site never overlap while one is uncertain.
   */
  site: Schema.String,
  /** What the hub fixed when it decided, as JSON text: what it sends, and what reading back compares against. */
  plan: Schema.String,
  /** What the hob is told when reading the Charm back finds the call took effect. */
  appliedText: Schema.String,
  state: CharmCallState,
  /** What the hob was or will be told, once there is a result. */
  result: Schema.NullOr(Schema.String),
  /** The reply step the call showed as, when the runtime gave one, so the user can settle it there. */
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  stepId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/**
 * The key every Charm write carries (ADR 020, ADR 031), which the hub action pipeline adds to the
 * write's input: a retried call returns the first result and is sent once.
 */
export const CharmWriteKey = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)).annotate({
  description:
    "A key you choose for this call, unique among your calls for this Task. Send the same key when you retry the same call, so it is sent once. A key you used for earlier work is free to use again.",
});
