import { Schema } from "effect";
import { AgentId } from "./ids.ts";
import { HobColor, LookSeed } from "./look.ts";

/** Runtimes an agent can run on. Only Claude Code is wired in the first slice. */
export const RuntimeKind = Schema.Literals(["claude-code"]);
export type RuntimeKind = typeof RuntimeKind.Type;

/** How much a hob thinks before answering; the runtime reports which levels each model accepts. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/** Numbers a hob's configurations from 1; each edit adds the next one (AG-002). */
export const ConfigVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type ConfigVersion = typeof ConfigVersion.Type;

export class Agent extends Schema.Class<Agent>("Agent")({
  id: AgentId,
  name: Schema.String,
  /** What the hob is good at, such as "Guide" or "Scribe". */
  craft: Schema.String,
  runtime: RuntimeKind,
  /** A model the runtime supports, or null for the runtime's default. */
  model: Schema.NullOr(Schema.String),
  /** An effort level the model accepts, or null for the model's default. */
  effort: Schema.NullOr(Effort),
  instructions: Schema.String,
  lookSeed: LookSeed,
  lookColor: HobColor,
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
  craft: Schema.String,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  instructions: Schema.String,
  lookSeed: LookSeed,
  lookColor: HobColor,
  createdAt: Schema.String,
}) {}
