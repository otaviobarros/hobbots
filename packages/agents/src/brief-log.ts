import type { Brief, BriefDraft, EventEnvelope, TaskId, ThreadId } from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/** Where the projector's cursor and the briefs are kept. */
export class BriefLog extends Context.Service<
  BriefLog,
  {
    /** The journal sequence the projector has read through. */
    readonly cursor: Effect.Effect<number>;
    /** Committed journal entries after `sequence`, in order, at most `limit` of them. */
    readonly readAfter: (sequence: number, limit: number) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    /** The threads the Tasks were asked in, each once; a Task with no thread names none. */
    readonly threadsOfTasks: (taskIds: ReadonlyArray<TaskId>) => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** The thread's brief, if the projector wrote one. */
    readonly briefOf: (threadId: ThreadId) => Effect.Effect<Option.Option<Brief>>;
    /**
     * In one transaction: writes each draft its rule (`briefChange`) lets through, journaled as
     * `BriefWritten`, and moves the cursor forward to `sequence`. Answers the entries it journaled.
     */
    readonly record: (
      sequence: number,
      drafts: ReadonlyArray<BriefDraft>,
      at: string,
    ) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
  }
>()("@hobbots/agents/BriefLog") {}
