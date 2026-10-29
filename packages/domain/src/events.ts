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
  Schema.TaggedStruct("MessageDelta", {
    threadId: ThreadId,
    messageId: MessageId,
    delta: Schema.String,
  }),
]);
export type HobbotsEvent = typeof HobbotsEvent.Type;
