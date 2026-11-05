import { AgentId, MemorySave, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound } from "./errors.ts";
import { MemoryNotAnswering, MemoryScopes } from "./memory-pages.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * Memory in a chat and on a hob's page (ADR 028, #961): the saves a thread's replies made, Undo for
 * one of them, and what a hob reads. Every call goes through the hub, as you.
 */

/** There is no such save. */
export class MemorySaveNotFound extends Schema.TaggedError<MemorySaveNotFound>()(
  "MemorySaveNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/**
 * The save cannot be undone: it never reached memory (`not-saved`), it was undone already
 * (`undone`), or its page changed after it (`newer`), which Undo never throws away.
 */
export class MemorySaveNotUndoable extends Schema.TaggedError<MemorySaveNotUndoable>()(
  "MemorySaveNotUndoable",
  { reason: Schema.Literals(["not-saved", "undone", "newer"]) },
  { httpApiStatus: 409 },
) {}

export class HobMemoryGroup extends HttpApiGroup.make("hobMemory")
  .add(
    // The saves the thread's replies made, oldest first; the stream adds later ones as
    // `MemorySaveRecorded` and `MemorySaveChanged`.
    HttpApiEndpoint.get("threadSaves", "/threads/:threadId/memory-saves", {
      params: { threadId: ThreadId },
      success: Schema.Array(MemorySave),
    }),
  )
  .add(
    // Puts back the version the save replaced, or removes the page it made, while it is the latest.
    HttpApiEndpoint.post("undoSave", "/memory-saves/:saveId/undo", {
      params: { saveId: Schema.String },
      success: MemorySave,
      error: [MemoryNotAnswering, MemorySaveNotFound, MemorySaveNotUndoable],
    }),
  )
  .add(
    // What the hob reads, with each scope's count: its own memory, About you, then its projects.
    HttpApiEndpoint.get("hobScopes", "/agents/:agentId/memory", {
      params: { agentId: AgentId },
      success: MemoryScopes,
      error: [AgentNotFound, MemoryNotAnswering],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
