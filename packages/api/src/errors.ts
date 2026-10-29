import { AgentId, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  { agentId: AgentId },
  { httpApiStatus: 404 },
) {}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()(
  "ThreadNotFound",
  { threadId: ThreadId },
  { httpApiStatus: 404 },
) {}

export class ThreadBusy extends Schema.TaggedError<ThreadBusy>()(
  "ThreadBusy",
  { threadId: ThreadId },
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
