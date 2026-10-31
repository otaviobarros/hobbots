import { Schema } from "effect";
import { Effort, RuntimeKind } from "./agent.ts";

export const RuntimeAvailability = Schema.Literals(["ready", "outdated", "signedOut", "unavailable", "unverified"]);
export type RuntimeAvailability = typeof RuntimeAvailability.Type;

/**
 * Whether an enforcement capability holds for the installed runtime on this hub (ADR 014). An
 * unverified capability counts as missing until it is verified.
 */
export const EnforcementCapability = Schema.Struct({
  status: Schema.Literals(["verified", "unsupported", "unverified"]),
  /** What the adapter found, such as the sandbox's platform or the prerequisite it is missing. */
  evidence: Schema.String,
});
export type EnforcementCapability = typeof EnforcementCapability.Type;

/** What a runtime adapter enforces on this hub, as provider health and the hob profile show it. */
export const RuntimeEnforcement = Schema.Struct({
  /** Every tool call reaches the policy hook first, and nothing is loaded from settings on disk. */
  toolInterception: EnforcementCapability,
  /** The runtime starts inside Hobbots' sandbox. Without it, commands, local Git and the web are blocked. */
  processSandbox: EnforcementCapability,
  /** Charms and coordination tools served over the runtime's control channel. */
  hubTools: EnforcementCapability,
  /** Tool start, finish and denial are reported. */
  toolEvents: EnforcementCapability,
  /** A running tool can be stopped. */
  toolInterruption: EnforcementCapability,
});
export type RuntimeEnforcement = typeof RuntimeEnforcement.Type;

/** The enforcement capabilities, in the order the UI lists them. */
export const ENFORCEMENT_CAPABILITIES = [
  "toolInterception",
  "processSandbox",
  "hubTools",
  "toolEvents",
  "toolInterruption",
] as const satisfies ReadonlyArray<keyof RuntimeEnforcement>;

export class RuntimeHealth extends Schema.Class<RuntimeHealth>("RuntimeHealth")({
  runtime: RuntimeKind,
  availability: RuntimeAvailability,
  /** Where requests are billed from, as reported by the runtime (e.g. "subscription", "api-key"). */
  billing: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
  /** What the adapter enforces on this hub, whatever the runtime's availability. */
  enforcement: RuntimeEnforcement,
}) {}

/** A model a hob can think with, as the runtime offers it. */
export class RuntimeModel extends Schema.Class<RuntimeModel>("RuntimeModel")({
  /** What the runtime is given, such as "sonnet" or "claude-opus-4-8". */
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  /** Effort levels the model accepts; empty when it takes no effort setting. */
  efforts: Schema.Array(Effort),
  /** Whether the vendor counts it among its main models; the rest are offered behind "More models". */
  main: Schema.Boolean,
}) {}

/** The models a runtime offers, and whether the runtime itself reported them. */
export class RuntimeModels extends Schema.Class<RuntimeModels>("RuntimeModels")({
  runtime: RuntimeKind,
  /** "runtime" when the installed runtime listed them; "fallback" for the documented list. */
  source: Schema.Literals(["runtime", "fallback"]),
  models: Schema.Array(RuntimeModel),
}) {}
