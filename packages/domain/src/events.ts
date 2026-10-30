import { Schema } from "effect";
import { Agent } from "./agent.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { Message } from "./message.ts";
import { Thread } from "./thread.ts";

const AgentUpserted = Schema.TaggedStruct("AgentUpserted", { agent: Agent });
const ThreadUpserted = Schema.TaggedStruct("ThreadUpserted", { thread: Thread });
const MessageUpserted = Schema.TaggedStruct("MessageUpserted", { message: Message });
/** A user message joined its thread's queue because a reply was running. */
const MessageQueued = Schema.TaggedStruct("MessageQueued", { message: Message });
/** A queued message left the queue: its turn started (after its MessageUpserted), or the user removed it. */
const MessageDequeued = Schema.TaggedStruct("MessageDequeued", {
  threadId: ThreadId,
  messageId: MessageId,
  reason: Schema.Literals(["started", "removed"]),
});
/** The user asked to stop a reply; it shows as stopping until the runtime confirms. */
const TurnStopRequested = Schema.TaggedStruct("TurnStopRequested", { threadId: ThreadId, messageId: MessageId });
/** The runtime confirmed the stopped turn ended; the reply is now stopped. */
const TurnStopped = Schema.TaggedStruct("TurnStopped", { threadId: ThreadId, messageId: MessageId });
/** A piece of a streaming reply. Transient: its text reaches durable state through the message (ADR 013). */
const MessageDelta = Schema.TaggedStruct("MessageDelta", {
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
});

/** State events: each is written to the event journal in the transaction that makes its change (ADR 013). */
export const JournaledEvent = Schema.Union([
  AgentUpserted,
  ThreadUpserted,
  MessageUpserted,
  MessageQueued,
  MessageDequeued,
  TurnStopRequested,
  TurnStopped,
]);
export type JournaledEvent = typeof JournaledEvent.Type;

/** Events pushed to clients over SSE after the matching state change is committed. */
export const HobbotsEvent = Schema.Union([...JournaledEvent.members, MessageDelta]);
export type HobbotsEvent = typeof HobbotsEvent.Type;
export type MessageDelta = typeof MessageDelta.Type;

/** Each journaled event type's payload version, from 1; an incompatible payload change bumps it (ADR 013). */
export const EVENT_SCHEMA_VERSIONS: Record<JournaledEvent["_tag"], number> = {
  AgentUpserted: 1,
  ThreadUpserted: 1,
  MessageUpserted: 1,
  MessageQueued: 1,
  MessageDequeued: 1,
  TurnStopRequested: 1,
  TurnStopped: 1,
};

/** The IDs a journaled event applies to, for authorization filtering and tracing. */
export const EventCorrelation = Schema.Struct({
  agentId: Schema.NullOr(AgentId),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
});
export type EventCorrelation = typeof EventCorrelation.Type;

/** A committed journal entry: the envelope every journaled event is stored and sent in (ADR 013). */
export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: Schema.String,
  /** Unique and gap-free per installation, in commit order. */
  sequence: Schema.Int,
  schemaVersion: Schema.Int,
  /** The payload's `_tag`. */
  type: Schema.String,
  /** When the change committed. Display only; order comes from `sequence`. */
  occurredAt: Schema.String,
  correlation: EventCorrelation,
  /** The event that caused this one, if any. */
  causationId: Schema.NullOr(Schema.String),
  payload: JournaledEvent,
}) {}

/** The events a saved message produces: always its upsert, then that it queued or any stop outcome it records. */
export const messageEvents = (message: Message): ReadonlyArray<JournaledEvent> => {
  const ids = { threadId: message.threadId, messageId: message.id };
  const upserted: JournaledEvent = { _tag: "MessageUpserted", message };
  switch (message.status) {
    case "queued":
      return [upserted, { _tag: "MessageQueued", message }];
    case "stopping":
      return [upserted, { _tag: "TurnStopRequested", ...ids }];
    case "stopped":
      return [upserted, { _tag: "TurnStopped", ...ids }];
    default:
      return [upserted];
  }
};
