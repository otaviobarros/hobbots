import { Schema } from "effect";
import { AgentId } from "./ids.ts";
import { HobColor, LookSeed } from "./look.ts";

/** Runtimes an agent can run on. Only Claude Code is wired in the first slice. */
export const RuntimeKind = Schema.Literals(["claude-code"]);
export type RuntimeKind = typeof RuntimeKind.Type;

export class Agent extends Schema.Class<Agent>("Agent")({
  id: AgentId,
  name: Schema.String,
  role: Schema.String,
  runtime: RuntimeKind,
  model: Schema.NullOr(Schema.String),
  instructions: Schema.String,
  lookSeed: LookSeed,
  lookColor: HobColor,
  createdAt: Schema.String,
}) {}
