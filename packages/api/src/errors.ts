import { AgentId, AgentStatus, MessageId, PolicyOperation, SafetyPreset, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  { agentId: AgentId },
  { httpApiStatus: 404 },
) {}

/**
 * A hob that is not active refuses new work: a paused hob until it is woken, a retired hob for
 * good. Also returned when pausing or waking a retired hob.
 */
export class HobUnavailable extends Schema.TaggedError<HobUnavailable>()(
  "HobUnavailable",
  { agentId: AgentId, status: AgentStatus },
  { httpApiStatus: 409 },
) {}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()(
  "ThreadNotFound",
  { threadId: ThreadId },
  { httpApiStatus: 404 },
) {}

/** A message that is not waiting in the thread's queue: it already started, was removed, or is elsewhere. */
export class MessageNotQueued extends Schema.TaggedError<MessageNotQueued>()(
  "MessageNotQueued",
  { messageId: MessageId },
  { httpApiStatus: 409 },
) {}

/**
 * A new hob the server will not create: a field that fails the payload schema, or a brain the
 * runtime does not offer. `field` names the payload field, or is null when the body is not a hob.
 */
export class InvalidHob extends Schema.TaggedError<InvalidHob>()(
  "InvalidHob",
  { field: Schema.NullOr(Schema.String), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** A folder the hub will not let hobs work in: not an absolute path, or not a folder on the hub. */
export class InvalidFolder extends Schema.TaggedError<InvalidFolder>()(
  "InvalidFolder",
  { folder: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * A per-hob override that would allow more than the installation's preset. Overrides only narrow;
 * a widening needs a separately recorded user grant (ADR 014).
 */
export class OverrideWidens extends Schema.TaggedError<OverrideWidens>()(
  "OverrideWidens",
  { preset: SafetyPreset, operations: Schema.Array(PolicyOperation), message: Schema.String },
  { httpApiStatus: 400 },
) {}
