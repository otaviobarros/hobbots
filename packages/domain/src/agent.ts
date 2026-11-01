import { Effect, Schema } from "effect";
import { AgentId } from "./ids.ts";
import { HobColor, LookSeed } from "./look.ts";
import { EMPTY_HOB_POLICY, HobPolicy } from "./policy.ts";
import { Revision } from "./revision.ts";
import { DEFAULT_SIGIL, RoleHat, RoleId, RoleTool } from "./roles.ts";
import { DEFAULT_LENGTH, DEFAULT_VOICE, ReplyLength, Voice } from "./tone.ts";

/**
 * Runtimes a hob can think with. A hub serves those it has an adapter for and lists the others as
 * unavailable (ADR 017); Codex has no adapter yet (#12).
 */
export const RuntimeKind = Schema.Literals(["claude-code", "codex"]);
export type RuntimeKind = typeof RuntimeKind.Type;

/** What the UI calls each runtime. */
export const RUNTIME_NAMES: Record<RuntimeKind, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** The runtime every hob thought with before a hob's runtime was versioned with its configuration. */
export const DEFAULT_RUNTIME: RuntimeKind = "claude-code";

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

/**
 * How a hob talks; the defaults add nothing to what the runtime is told. Hob events journaled
 * before tone existed carry neither field, so decoding them fills in the defaults (ADR 013).
 */
const toneSchemaFields = {
  voice: Voice.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_VOICE)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_VOICE)),
  ),
  length: ReplyLength.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_LENGTH)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_LENGTH)),
  ),
};

/**
 * The hob's own folders and overrides (ADR 014). Hob events journaled before policies existed carry
 * none, so decoding them fills in the empty policy: the shared folders and the preset as they are.
 */
const policySchemaFields = {
  policy: HobPolicy.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(EMPTY_HOB_POLICY)),
    Schema.withConstructorDefault(Effect.succeed(EMPTY_HOB_POLICY)),
  ),
};

export class Agent extends Schema.Class<Agent>("Agent")({
  id: AgentId,
  name: Schema.String,
  ...roleSchemaFields,
  ...toneSchemaFields,
  ...policySchemaFields,
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
  revision: Revision,
}) {}

/**
 * One version of a hob's configuration, kept unchanged once written. A turn runs with the version
 * that was current when it started, even if the hob is edited while it runs.
 */
export class AgentConfiguration extends Schema.Class<AgentConfiguration>("AgentConfiguration")({
  agentId: AgentId,
  version: ConfigVersion,
  ...roleSchemaFields,
  ...toneSchemaFields,
  ...policySchemaFields,
  /** Versioned since ADR 017, so a turn keeps the runtime it started with. */
  runtime: RuntimeKind.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_RUNTIME)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_RUNTIME)),
  ),
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
