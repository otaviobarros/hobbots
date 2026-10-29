import { Schema } from "effect";
import { RuntimeKind } from "./agent.ts";

export const RuntimeAvailability = Schema.Literals(["ready", "outdated", "unavailable", "unverified"]);

export class RuntimeHealth extends Schema.Class<RuntimeHealth>("RuntimeHealth")({
  runtime: RuntimeKind,
  availability: RuntimeAvailability,
  /** Where requests are billed from, as reported by the runtime (e.g. "subscription", "api-key"). */
  billing: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
}) {}
