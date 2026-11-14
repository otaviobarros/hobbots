import type { Committed, Supervision, TaskId } from "@hobbots/domain";
import { Context, type Effect } from "effect";

/**
 * Where the supervisor keeps its record of each Task it acted on (#1447), so a retry budget holds
 * across restarts and each rule acts once on each fact. Nothing else reads or writes them.
 */
export class SupervisionRecords extends Context.Service<
  SupervisionRecords,
  {
    /** The records of the Tasks in one tree, by its top Task. */
    readonly listIn: (rootId: TaskId) => Effect.Effect<ReadonlyArray<Supervision>>;
    /** Keeps a Task's record, replacing the one it had, journaled as `TaskSupervised`. */
    readonly save: (record: Supervision) => Effect.Effect<Committed<Supervision>>;
  }
>()("@hobbots/agents/SupervisionRecords") {}
