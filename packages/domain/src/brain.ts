import { Schema } from "effect";
import { Effort, RUNTIME_NAMES, RuntimeKind } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";
import { TaskId } from "./task.ts";

/** What a hob thinks with: a runtime, one of its models (null for its default) and an effort. */
export const Brain = Schema.Struct({
  runtime: RuntimeKind,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
});
export type Brain = typeof Brain.Type;

/** Whether two brains are the same runtime, model and effort. */
export const sameBrain = (a: Brain, b: Brain): boolean =>
  a.runtime === b.runtime && a.model === b.model && a.effort === b.effort;

/** "Claude Code", or "Claude Code · Sonnet" when a model is named. */
export const brainLabel = (runtime: RuntimeKind, model: string | null): string =>
  model === null ? RUNTIME_NAMES[runtime] : `${RUNTIME_NAMES[runtime]} · ${model}`;

/**
 * What a lead's session was last told of the Task it works on in its chat (#1027): the Task, and a
 * fingerprint of each piece of its briefing that can change between turns, by a key that names the
 * piece. A later turn on the same Task sends only the pieces whose fingerprint changed.
 */
export const TaskBriefMark = Schema.Struct({
  taskId: TaskId,
  entries: Schema.Record(Schema.String, Schema.String),
});
export type TaskBriefMark = typeof TaskBriefMark.Type;

/**
 * A thread's binding to one runtime's session (ADR 017). A thread keeps one per runtime it has
 * used, so switching back resumes that runtime's own session.
 */
export const RuntimeSession = Schema.Struct({
  runtime: RuntimeKind,
  /** The runtime's own id for the session. */
  sessionId: Schema.String,
  /** The last message the session has seen, so switching back sends only what came after it. */
  seenThrough: Schema.NullOr(MessageId),
  /**
   * The fingerprint of the memory brief the session last received (ADR 028), so an unchanged brief
   * is not sent again. Absent or null when it is not known, and the next turn sends it.
   */
  memoryBrief: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * What the session was last told of the Task its hob works on in the thread (#1027). Absent or
   * null when it is not known, and the next turn sends the whole briefing.
   */
  taskBrief: Schema.optionalKey(Schema.NullOr(TaskBriefMark)),
});
export type RuntimeSession = typeof RuntimeSession.Type;

/**
 * The stored summary of a thread's older messages, reused by the next handoff so history is not
 * summarized again on every switch (ADR 017).
 */
export class ThreadCheckpoint extends Schema.Class<ThreadCheckpoint>("ThreadCheckpoint")({
  threadId: ThreadId,
  /** The last message the summary covers. */
  throughMessageId: MessageId,
  /** One line per message summarized, oldest first. */
  lines: Schema.Array(Schema.String),
  /** How many older messages were left out to keep the summary within its budget. */
  omitted: Schema.Int,
  createdAt: Schema.String,
}) {}
