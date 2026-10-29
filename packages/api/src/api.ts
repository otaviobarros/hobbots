import {
  Agent,
  AgentId,
  Effort,
  HobbotsEvent,
  HobColor,
  LookSeed,
  Message,
  RuntimeHealth,
  RuntimeKind,
  RuntimeModels,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/http-api";
import { AgentNotFound, InvalidHob, ThreadBusy, ThreadNotFound } from "./errors.ts";
import { SetupGroup } from "./setup.ts";

// Short enough for a name tag and a tile; trimmed so "  " is not a name.
const Label = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(40));

/** A new hob: who it is, how it looks and what it thinks with. */
export const CreateAgentPayload = Schema.Struct({
  name: Label,
  craft: Label,
  lookSeed: LookSeed,
  lookColor: HobColor,
  runtime: RuntimeKind,
  /** A model from the runtime's list, or null for its default. */
  model: Schema.NullOr(Schema.NonEmptyString),
  /** An effort the model accepts, or null for its default. */
  effort: Schema.NullOr(Effort),
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type CreateAgentPayload = typeof CreateAgentPayload.Type;

/** Reports a create request that fails the payload schema as an `InvalidHob` naming the field. */
export class HobInputErrors extends HttpApiMiddleware.Service<HobInputErrors>()("@hobbots/api/HobInputErrors", {
  error: InvalidHob,
}) {}

export const SendPromptPayload = Schema.Struct({
  content: Schema.NonEmptyString,
});

export const SendPromptResult = Schema.Struct({
  userMessage: Message,
  assistantMessage: Message,
});

/**
 * What the health endpoint returns: enough for a client to tell this installation's server from
 * another installation's, or from a program that is not Hobbots at all (ADR 012).
 */
export const ServerIdentity = Schema.Struct({
  app: Schema.Literal("hobbots"),
  installationId: Schema.NonEmptyString,
  version: Schema.String,
  dataDir: Schema.String,
});
export type ServerIdentity = typeof ServerIdentity.Type;

/** A hob with a turn in progress. */
export const WorkingHob = Schema.Struct({
  agentId: AgentId,
  name: Schema.String,
  threadId: ThreadId,
});

/** What the hub is doing right now; the desktop app asks before closing would stop the work. */
export const Activity = Schema.Struct({
  working: Schema.Array(WorkingHob),
});

export class AgentsGroup extends HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("list", "/agents", { success: Schema.Array(Agent) }),
    HttpApiEndpoint.post("create", "/agents", {
      payload: CreateAgentPayload,
      success: Agent,
      error: InvalidHob,
    }).middleware(HobInputErrors),
    HttpApiEndpoint.get("threads", "/agents/:agentId/threads", {
      params: { agentId: AgentId },
      success: Schema.Array(Thread),
      error: AgentNotFound,
    }),
    HttpApiEndpoint.post("createThread", "/agents/:agentId/threads", {
      params: { agentId: AgentId },
      success: Thread,
      error: AgentNotFound,
    }),
  )
  .prefix("/api") {}

export class ThreadsGroup extends HttpApiGroup.make("threads")
  .add(
    HttpApiEndpoint.get("messages", "/threads/:threadId/messages", {
      params: { threadId: ThreadId },
      success: Schema.Array(Message),
      error: ThreadNotFound,
    }),
    HttpApiEndpoint.post("sendPrompt", "/threads/:threadId/messages", {
      params: { threadId: ThreadId },
      payload: SendPromptPayload,
      success: SendPromptResult,
      error: [ThreadNotFound, ThreadBusy],
    }),
    HttpApiEndpoint.post("interrupt", "/threads/:threadId/interrupt", {
      params: { threadId: ThreadId },
      error: ThreadNotFound,
    }),
  )
  .prefix("/api") {}

export class SystemGroup extends HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/health", { success: ServerIdentity }),
    HttpApiEndpoint.get("activity", "/activity", { success: Activity }),
    HttpApiEndpoint.get("runtimes", "/runtimes", {
      success: Schema.Array(RuntimeHealth),
    }),
    HttpApiEndpoint.get("events", "/events", {
      success: HttpApiSchema.StreamSse({ data: HobbotsEvent }),
    }),
  )
  .prefix("/api") {}

/** What each runtime offers a hob's brain. */
export class RuntimesGroup extends HttpApiGroup.make("runtimes")
  .add(
    HttpApiEndpoint.get("models", "/runtimes/:runtime/models", {
      params: { runtime: RuntimeKind },
      success: RuntimeModels,
    }),
  )
  .prefix("/api") {}

export class HobbotsApi extends HttpApi.make("hobbots")
  .add(AgentsGroup)
  .add(ThreadsGroup)
  .add(SystemGroup)
  .add(SetupGroup)
  .add(RuntimesGroup) {}
