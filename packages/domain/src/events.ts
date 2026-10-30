import { Schema } from "effect";
import { Agent } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";
import { Message } from "./message.ts";
import { Thread } from "./thread.ts";

/** Events pushed to clients over SSE after the matching state change is committed. */
export const HobbotsEvent = Schema.Union([
  Schema.TaggedStruct("AgentUpserted", { agent: Agent }),
  Schema.TaggedStruct("ThreadUpserted", { thread: Thread }),
  Schema.TaggedStruct("MessageUpserted", { message: Message }),
  /** A user message joined its thread's queue because a reply was running. */
  Schema.TaggedStruct("MessageQueued", { message: Message }),
  /** A queued message left the queue: its turn started (after its MessageUpserted), or the user removed it. */
  Schema.TaggedStruct("MessageDequeued", {
    threadId: ThreadId,
    messageId: MessageId,
    reason: Schema.Literals(["started", "removed"]),
  }),
  Schema.TaggedStruct("MessageDelta", {
    threadId: ThreadId,
    messageId: MessageId,
    delta: Schema.String,
  }),
  /** The user asked to stop a reply; it shows as stopping until the runtime confirms. */
  Schema.TaggedStruct("TurnStopRequested", { threadId: ThreadId, messageId: MessageId }),
  /** The runtime confirmed the stopped turn ended; the reply is now stopped. */
  Schema.TaggedStruct("TurnStopped", { threadId: ThreadId, messageId: MessageId }),
]);
export type HobbotsEvent = typeof HobbotsEvent.Type;
