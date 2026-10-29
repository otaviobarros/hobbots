import { Schema } from "effect";
import { Effort, RuntimeKind } from "./agent.ts";

export const RuntimeAvailability = Schema.Literals(["ready", "outdated", "signedOut", "unavailable", "unverified"]);

export class RuntimeHealth extends Schema.Class<RuntimeHealth>("RuntimeHealth")({
  runtime: RuntimeKind,
  availability: RuntimeAvailability,
  /** Where requests are billed from, as reported by the runtime (e.g. "subscription", "api-key"). */
  billing: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
}) {}

/** A model a hob can think with, as the runtime offers it. */
export class RuntimeModel extends Schema.Class<RuntimeModel>("RuntimeModel")({
  /** What the runtime is given, such as "sonnet" or "claude-opus-4-8". */
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  /** Effort levels the model accepts; empty when it takes no effort setting. */
  efforts: Schema.Array(Effort),
}) {}

/** The models a runtime offers, and whether the runtime itself reported them. */
export class RuntimeModels extends Schema.Class<RuntimeModels>("RuntimeModels")({
  runtime: RuntimeKind,
  /** "runtime" when the installed runtime listed them; "fallback" for the documented list. */
  source: Schema.Literals(["runtime", "fallback"]),
  models: Schema.Array(RuntimeModel),
}) {}
