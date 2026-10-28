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
