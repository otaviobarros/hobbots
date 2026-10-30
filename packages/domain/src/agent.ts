import { Effect, Schema } from "effect";
import { AgentId } from "./ids.ts";
import { HobColor, LookSeed } from "./look.ts";
import { DEFAULT_SIGIL, RoleHat, RoleId, RoleTool } from "./roles.ts";

/** Runtimes an agent can run on. Only Claude Code is wired in the first slice. */
export const RuntimeKind = Schema.Literals(["claude-code"]);
export type RuntimeKind = typeof RuntimeKind.Type;

/** How much a hob thinks before answering; the runtime reports which levels each model accepts. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/** Numbers a hob's configurations from 1; each edit adds the next one (AG-002). */
export const ConfigVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type ConfigVersion = typeof ConfigVersion.Type;
/**
 * Where a hob is in its life (AG-006). A paused hob keeps its threads but starts no new turns until
 * it is woken; a retired hob takes no new work ever again and stays readable under Archived hobs.
 */
export const AgentStatus = Schema.Literals(["active", "paused", "retired"]);
export type AgentStatus = typeof AgentStatus.Type;

/**
 * A hob's role: a starter role or a title in the user's own words, with the sigil, hat and tool that
 * go with it. A label only; it grants nothing (ADR 005).
 */
const roleSchemaFields = {
  /** The starter role, or null when the title is the user's own words. */
  role: Schema.NullOr(RoleId).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /** The starter role's title or the user's own words, such as "Frontend engineer". */
  roleTitle: Schema.String,
  /** The starter role whose sigil the hob shows; a custom title can borrow any of them. */
  sigil: RoleId.pipe(Schema.withConstructorDefault(Effect.succeed(DEFAULT_SIGIL))),
  /** The hat its sprite wears, or null to leave it to the look seed. */
  hat: Schema.NullOr(RoleHat).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /** The tool its sprite holds, or null to leave it to the look seed. */
  tool: Schema.NullOr(RoleTool).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
};

export class Agent extends Schema.Class<Agent>("Agent")({
  id: AgentId,
  name: Schema.String,
  ...roleSchemaFields,
  runtime: RuntimeKind,
  /** A model the runtime supports, or null for the runtime's default. */
  model: Schema.NullOr(Schema.String),
  /** An effort level the model accepts, or null for the model's default. */
  effort: Schema.NullOr(Effort),
  instructions: Schema.String,
  lookSeed: LookSeed,
  lookColor: HobColor,
  /** A new hob starts active. */
  status: AgentStatus.pipe(Schema.withConstructorDefault(Effect.succeed("active" as const))),
  /** When the hob was retired; null until then, and for hobs retired before this was recorded. */
  retiredAt: Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /** The configuration version the fields above belong to. */
  configVersion: ConfigVersion,
  createdAt: Schema.String,
}) {}

/**
 * One version of a hob's configuration, kept unchanged once written. A turn runs with the version
 * that was current when it started, even if the hob is edited while it runs.
 */
export class AgentConfiguration extends Schema.Class<AgentConfiguration>("AgentConfiguration")({
  agentId: AgentId,
  version: ConfigVersion,
  ...roleSchemaFields,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  instructions: Schema.String,
  lookSeed: LookSeed,
  lookColor: HobColor,
  createdAt: Schema.String,
}) {}

/** What happens to a retiring hob's running replies: they finish on their own, or stop now. */
export const RetireWork = Schema.Literals(["finish", "stop"]);
export type RetireWork = typeof RetireWork.Type;

export class InvalidAgentTransition extends Schema.TaggedError<InvalidAgentTransition>()("InvalidAgentTransition", {
  agentId: AgentId,
  from: AgentStatus,
  action: Schema.String,
}) {}

const move = (
  agent: Agent,
  action: string,
  from: ReadonlyArray<AgentStatus>,
  to: AgentStatus,
  changes: Partial<Agent> = {},
) => {
  if (agent.status === to) return agent;
  return from.includes(agent.status)
    ? new Agent({ ...agent, ...changes, status: to })
    : new InvalidAgentTransition({ agentId: agent.id, from: agent.status, action });
};

/**
 * Pure lifecycle transitions. Each is idempotent, so a repeated request returns the hob unchanged;
 * retiring is final, so a retired hob can be neither paused nor woken.
 */
export const AgentTransitions = {
  pause: (agent: Agent): Agent | InvalidAgentTransition => move(agent, "pause", ["active"], "paused"),
  wake: (agent: Agent): Agent | InvalidAgentTransition => move(agent, "wake", ["paused"], "active"),
  /** Records `at` (an ISO-8601 time) as when the hob retired. */
  retire: (agent: Agent, at: string): Agent | InvalidAgentTransition =>
    move(agent, "retire", ["active", "paused"], "retired", { retiredAt: at }),
};
