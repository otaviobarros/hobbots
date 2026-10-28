import { Agent, AgentId, HobbotsEvent, Message, RuntimeHealth, Thread, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AgentNotFound, ThreadBusy, ThreadNotFound } from "./errors.ts";

export const SendPromptPayload = Schema.Struct({
  content: Schema.NonEmptyString,
});

export const SendPromptResult = Schema.Struct({
  userMessage: Message,
  assistantMessage: Message,
});

export class AgentsGroup extends HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("list", "/agents", { success: Schema.Array(Agent) }),
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
    HttpApiEndpoint.get("health", "/health"),
    HttpApiEndpoint.get("runtimes", "/runtimes", {
      success: Schema.Array(RuntimeHealth),
    }),
    HttpApiEndpoint.get("events", "/events", {
      success: HttpApiSchema.StreamSse({ data: HobbotsEvent }),
    }),
  )
  .prefix("/api") {}

export class HobbotsApi extends HttpApi.make("hobbots").add(AgentsGroup).add(ThreadsGroup).add(SystemGroup) {}
