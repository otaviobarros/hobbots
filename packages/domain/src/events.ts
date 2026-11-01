import { Effect, Schema } from "effect";
import { Agent } from "./agent.ts";
import { ApprovalRequest } from "./approval.ts";
import { Grant } from "./grant.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { Message } from "./message.ts";
import { ArtifactRef, Checkpoint, Delegation, HandOff, Milestone, Quest, Question, TaskWait } from "./quest.ts";
import { Attempt, Task } from "./task.ts";
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
/** A tool call the policy answered Ask for paused its turn until the user decides (PE-003). */
const ApprovalRequested = Schema.TaggedStruct("ApprovalRequested", { approval: ApprovalRequest });
/** A pending approval was approved, denied or expired; `approval.state` says which. */
const ApprovalResolved = Schema.TaggedStruct("ApprovalResolved", { approval: ApprovalRequest });
/** A decision with a lifetime saved a standing grant for its hob (ADR 015). */
const GrantCreated = Schema.TaggedStruct("GrantCreated", { grant: Grant });
/** A grant stopped applying: the user removed it, or a change took away the authority it relied on. */
const GrantRevoked = Schema.TaggedStruct("GrantRevoked", { grant: Grant });
/** A Task, a step or a delegated Task was created, with its Delegation and planned Milestones (ADR 018). */
const TaskCreated = Schema.TaggedStruct("TaskCreated", {
  task: Task,
  delegation: Schema.NullOr(Delegation),
  milestones: Schema.Array(Milestone),
});
/**
 * A Task's state or current Attempt changed: a start, a retry, a wait, a cancel, or its Attempt
 * moving on. `attempt` is the current one when it changed; `quest` the Task's Quest when it ended with it;
 * `wait` the wait its owner started or replaced, so who it waits on shows live.
 */
const TaskStateChanged = Schema.TaggedStruct("TaskStateChanged", {
  task: Task,
  attempt: Schema.NullOr(Attempt),
  quest: Schema.NullOr(Quest),
  wait: Schema.NullOr(TaskWait).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
/** A Task gained its Quest record: its owner brought in another hob. */
const QuestStarted = Schema.TaggedStruct("QuestStarted", { quest: Quest });
/** A Checkpoint was recorded; `milestone` is the one it reached, now with `reachedAt`. */
const CheckpointRecorded = Schema.TaggedStruct("CheckpointRecorded", {
  checkpoint: Checkpoint,
  milestone: Schema.NullOr(Milestone),
});
const QuestionAsked = Schema.TaggedStruct("QuestionAsked", { question: Question });
const QuestionAnswered = Schema.TaggedStruct("QuestionAnswered", { question: Question });
/** A lead passed a question up: to the next lead, or to the user when `recipientId` is null. */
const QuestionEscalated = Schema.TaggedStruct("QuestionEscalated", { question: Question });
/** A lead gave one Task's artifact to another Task. */
const HandedOff = Schema.TaggedStruct("HandedOff", { handOff: HandOff, artifact: ArtifactRef });
/** A Task passed the completion gate, with its result and the artifacts it made. */
const TaskCompleted = Schema.TaggedStruct("TaskCompleted", { task: Task, artifacts: Schema.Array(ArtifactRef) });
/** The Task that holds a Quest passed the completion gate. */
const QuestCompleted = Schema.TaggedStruct("QuestCompleted", { quest: Quest });
/**
 * A piece of a streaming reply. Transient: its text reaches durable state through the message (ADR 013).
 * `offset` is where the piece starts in the message's text, in UTF-16 code units, so a client
 * applies it idempotently: it skips text it already has.
 */
export const MessageDelta = Schema.TaggedStruct("MessageDelta", {
  threadId: ThreadId,
  messageId: MessageId,
  offset: Schema.Int,
  delta: Schema.String,
});

/** A transient event: delivered live, never journaled. */
export type TransientEvent = MessageDelta;

/** State events: each is written to the event journal in the transaction that makes its change (ADR 013). */
export const JournaledEvent = Schema.Union([
  AgentUpserted,
  ThreadUpserted,
  MessageUpserted,
  MessageQueued,
  MessageDequeued,
  TurnStopRequested,
  TurnStopped,
  ApprovalRequested,
  ApprovalResolved,
  GrantCreated,
  GrantRevoked,
  TaskCreated,
  TaskStateChanged,
  QuestStarted,
  CheckpointRecorded,
  QuestionAsked,
  QuestionAnswered,
  QuestionEscalated,
  HandedOff,
  TaskCompleted,
  QuestCompleted,
]);
export type JournaledEvent = typeof JournaledEvent.Type;

/** Events pushed to clients over SSE after the matching state change is committed. */
export const HobbotsEvent = Schema.Union([...JournaledEvent.members, MessageDelta]);
export type HobbotsEvent = typeof HobbotsEvent.Type;
export type MessageDelta = typeof MessageDelta.Type;

/** Each journaled event type's payload version, from 1; an incompatible payload change bumps it (ADR 013). */
export const EVENT_SCHEMA_VERSIONS: Record<JournaledEvent["_tag"], number> = {
  AgentUpserted: 1,
  // 2: a thread carries its `sessions` and its own `brain`. 3: its `archivedAt`.
  ThreadUpserted: 3,
  // 2: a reply can be `limited`, with `resetsAt`. 3: a reply carries its `steps`. 4: its `runtime` and `model`.
  MessageUpserted: 4,
  MessageQueued: 1,
  MessageDequeued: 1,
  TurnStopRequested: 1,
  TurnStopped: 1,
  // A request's `grantable`, `rules`, `lifetime` and `expiresAt` were added with defaults, compatibly.
  ApprovalRequested: 1,
  ApprovalResolved: 1,
  GrantCreated: 1,
  GrantRevoked: 1,
  TaskCreated: 1,
  // A change's `wait` was added with a default, compatibly.
  TaskStateChanged: 1,
  QuestStarted: 1,
  CheckpointRecorded: 1,
  QuestionAsked: 1,
  QuestionAnswered: 1,
  QuestionEscalated: 1,
  HandedOff: 1,
  TaskCompleted: 1,
  QuestCompleted: 1,
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

/** A committed write: what it stored, and the journal entries it appended, in sequence order. */
export interface Committed<A> {
  readonly value: A;
  readonly entries: ReadonlyArray<EventEnvelope>;
}

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

/**
 * The first frame of every event stream connection (ADR 013). `cursor` is where the connection
 * starts. `resumed` is false when the client's cursor was missing, from another journal epoch or past
 * retention: nothing was replayed, and the client refetches its queries as the snapshot.
 */
export const StreamReady = Schema.Struct({ cursor: Schema.String, resumed: Schema.Boolean });
export type StreamReady = typeof StreamReady.Type;

/** The SSE event names on the event stream; a journaled entry is a plain `message` frame (ADR 013). */
export const STREAM_FRAME = { ready: "ready", delta: "delta" } as const;
