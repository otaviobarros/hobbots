import { Schema } from "effect";
import { AgentId, MessageId, ThreadId } from "./ids.ts";

/**
 * A Charm's write, recorded with its key before anything is sent (ADR 020), so a retried call is
 * never sent twice and a call that ended without a clear result is read back before anything else.
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
  /** The key the hob sent, unique among its calls. */
  key: Schema.String,
  /** The hub tool, such as `github_push`. */
  tool: Schema.String,
  /** The call's input as stable JSON without its key, so a key sent again with another call is told apart. */
  input: Schema.String,
  /**
   * Where it acts, such as `github.com/owner/name refs/heads/main` for a push. Two writes of the same
   * tool on one site never overlap while one is uncertain.
   */
  site: Schema.String,
  /** What the hub fixed when it decided, as JSON text: what it sends, and what reading back compares against. */
  plan: Schema.String,
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
