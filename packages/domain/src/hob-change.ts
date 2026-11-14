import { Schema } from "effect";
import { AgentConfiguration, AgentStatus } from "./agent.ts";
import { ChangeActor } from "./change-actor.ts";
import { AgentId, MessageId, TaskId, ThreadId } from "./ids.ts";
import { type HobPolicy, hobAnswers, type PolicyLayer } from "./policy.ts";
import { SUMMONING_CHARM_NAME } from "./summoning.ts";

/**
 * The request behind a change a hob made or proposed (ADR 034): the Charm whose call made it, the
 * Task it was made for, and the chat turn the call showed in. Each is null when the hub does not
 * know it, as for a call whose record is gone.
 */
export const HobChangeOrigin = Schema.Struct({
  /** The Charm's name as the hub words it, such as `Summoning`. */
  charm: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(TaskId),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
});
export type HobChangeOrigin = typeof HobChangeOrigin.Type;

/** A configuration version of the hob, with the one before it to compare against (none for the first). */
const VersionChange = Schema.TaggedStruct("Version", {
  hobId: AgentId,
  at: Schema.String,
  actor: ChangeActor,
  /** Null when the change was yours alone. */
  origin: Schema.NullOr(HobChangeOrigin),
  config: AgentConfiguration,
  previous: Schema.NullOr(AgentConfiguration),
});

/** The hob paused, woken, retired or brought back. */
const StatusChange = Schema.TaggedStruct("Status", {
  hobId: AgentId,
  at: Schema.String,
  actor: ChangeActor,
  origin: Schema.NullOr(HobChangeOrigin),
  from: AgentStatus,
  status: AgentStatus,
});

/**
 * One change to a hob, for its History and the Changes log (ADR 034): a new configuration version or
 * a change of its status, each with who made it.
 */
export const HobChange = Schema.Union([VersionChange, StatusChange]);
export type HobChange = typeof HobChange.Type;

/**
 * What a call's scope says about the work behind it (#660): `task:<Task id>` names its Task, and
 * `reply:<message id>` the chat reply it was made in.
 */
export const scopeWork = (scope: string): { readonly taskId: TaskId | null; readonly messageId: MessageId | null } => {
  const [kind, ...rest] = scope.split(":");
  const id = rest.join(":");
  if (id === "") return { taskId: null, messageId: null };
  return {
    taskId: kind === "task" ? TaskId.make(id) : null,
    messageId: kind === "reply" ? MessageId.make(id) : null,
  };
};

/**
 * The answers a Summoning change dropped without naming them (#1352): before the fix, a change that
 * set some answers replaced every other built-in or Charm answer the hob held. A change you made on
 * the hob's own tabs drops nothing this way, and a Summoning change now merges what it names.
 */
export const droppedAnswers = (change: HobChange): PolicyLayer => {
  if (change._tag !== "Version" || change.previous === null || change.actor._tag === "You") return {};
  if (change.origin?.charm !== SUMMONING_CHARM_NAME) return {};
  const after = hobAnswers(change.config.policy);
  return Object.fromEntries(
    Object.entries(hobAnswers(change.previous.policy)).filter(([operation]) => !(operation in after)),
  ) as PolicyLayer;
};

/** The answers `change` dropped that the hob, holding `current` now, still lacks: what restoring brings back. */
export const answersToRestore = (change: HobChange, current: HobPolicy): PolicyLayer => {
  const now = hobAnswers(current);
  return Object.fromEntries(
    Object.entries(droppedAnswers(change)).filter(([operation]) => !(operation in now)),
  ) as PolicyLayer;
};
