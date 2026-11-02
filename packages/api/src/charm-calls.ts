import { CharmCall, MessageId, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { CharmCallNotFound, CharmCallSettled, ThreadNotFound } from "./errors.ts";
import { UserSessionOnly } from "./user-session.ts";

/** How the user settles an uncertain Charm call from its step, after looking on GitHub (ADR 020). */
export const SettleCharmCallPayload = Schema.Struct({ outcome: Schema.Literals(["applied", "not-sent"]) });
export type SettleCharmCallPayload = typeof SettleCharmCallPayload.Type;

/** Charm calls and how each ended, by the reply steps they showed as. Only a user session reaches it (PE-006). */
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
  )
  .middleware(UserSessionOnly)
  .prefix("/api") {}
