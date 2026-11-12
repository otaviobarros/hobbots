import { CharmCall, MessageId, Task, TaskId, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { CharmCallNotFound, CharmCallSettled, ThreadNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/** How the user settles an uncertain Charm call, after looking on GitHub (ADR 020, ADR 038). */
export const SettleCharmCallPayload = Schema.Struct({ outcome: Schema.Literals(["applied", "not-sent"]) });
export type SettleCharmCallPayload = typeof SettleCharmCallPayload.Type;

/**
 * An uncertain Charm call a Task's session made, which only you can settle, with its Task as it is
 * now, so the Quest room and the Inbox can place it (ADR 038).
 */
export const WaitingCharmCall = Schema.Struct({ call: CharmCall, task: Task });
export type WaitingCharmCall = typeof WaitingCharmCall.Type;

/**
 * Charm calls and how each ended, by the reply steps they showed as, and the uncertain ones Tasks
 * made, by their Task. Only a user session reaches it (PE-006).
 */
export class CharmCallsGroup extends HttpApiGroup.make("charmCalls")
  .add(
    // The thread's Charm calls, oldest first, whatever their state.
    HttpApiEndpoint.get("forThread", "/threads/:threadId/charm-calls", {
      params: { threadId: ThreadId },
      success: Schema.Array(CharmCall),
      error: ThreadNotFound,
    }),
    // Settles the uncertain call a reply step showed as.
    HttpApiEndpoint.post("settle", "/threads/:threadId/messages/:messageId/steps/:stepId/settlement", {
      params: { threadId: ThreadId, messageId: MessageId, stepId: Schema.String },
      payload: SettleCharmCallPayload,
      success: CharmCall,
      error: [CharmCallNotFound, CharmCallSettled],
    }),
    // The uncertain calls Tasks' sessions made, oldest first, each with its Task (ADR 038).
    HttpApiEndpoint.get("waiting", "/charm-calls/waiting", {
      success: Schema.Array(WaitingCharmCall),
    }),
    // Settles the uncertain call a Task's session made, named by its sending (ADR 038).
    HttpApiEndpoint.post("settleOnTask", "/tasks/:taskId/charm-calls/:attempt/settlement", {
      params: { taskId: TaskId, attempt: Schema.String },
      payload: SettleCharmCallPayload,
      success: CharmCall,
      error: [CharmCallNotFound, CharmCallSettled],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
