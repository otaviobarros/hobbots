import { Schema } from "effect";
import { Effort, RUNTIME_NAMES, RuntimeKind } from "./agent.ts";
import { ChapterId, MessageId, ThreadId } from "./ids.ts";
import { TaskId } from "./task.ts";
import { WebReadMark } from "./web-mark.ts";

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
 * What a session holds of the roster of other hobs (ADR 032): the fingerprint of the roster it last
 * received, null when that is not known, and whether it holds `read_hob`. A runtime that keeps a
 * resumed session's first hub tools, as Codex does, holds it only when the session started with it.
 */
export const RosterMark = Schema.Struct({
  digest: Schema.NullOr(Schema.String),
  readHob: Schema.Boolean,
});
export type RosterMark = typeof RosterMark.Type;

/**
 * A thread's binding to one runtime's session (ADR 017), keyed by thread, runtime and chapter (ADR
 * 037). A thread keeps one per runtime it has used, so switching back inside a chapter resumes that
 * runtime's own session. A session belongs to the chapter it started in: a turn in a later chapter
 * starts a new one in its place and never resumes it.
 */
export const RuntimeSession = Schema.Struct({
  runtime: RuntimeKind,
  /** The runtime's own id for the session. */
  sessionId: Schema.String,
  /** The chapter the session belongs to; migration 0098 gave every earlier session its thread's first. */
  chapterId: ChapterId,
  /**
   * How many chapters had been merged into its chapter when the session started there (ADR 037).
   * A merge into the live chapter makes it live again with a new session, so a session that started
   * before the merge is never resumed, even one a turn under way records after it. Absent means 0.
   */
  chapterMerges: Schema.optionalKey(Schema.Int),
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
  /**
   * What the session holds of the roster of other hobs (ADR 032). Absent or null when it is not
   * known: the next turn sends the roster, and mentions `read_hob` only where the session holds it.
   */
  roster: Schema.optionalKey(Schema.NullOr(RosterMark)),
  /**
   * The session's read-the-web mark (ADR 036), once it searched or read a page. Absent or null while
   * it has read nothing; a new session in its place starts without it.
   */
  readWeb: Schema.optionalKey(Schema.NullOr(WebReadMark)),
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
