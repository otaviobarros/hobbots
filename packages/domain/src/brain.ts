import { Schema } from "effect";
import { Effort, RUNTIME_NAMES, RuntimeKind } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";

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
 * A thread's binding to one runtime's session (ADR 017). A thread keeps one per runtime it has
 * used, so switching back resumes that runtime's own session.
 */
export const RuntimeSession = Schema.Struct({
  runtime: RuntimeKind,
  /** The runtime's own id for the session. */
  sessionId: Schema.String,
  /** The last message the session has seen, so switching back sends only what came after it. */
  seenThrough: Schema.NullOr(MessageId),
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
