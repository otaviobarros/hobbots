import type { Attempt, AttemptActivity, Task, TaskTree } from "@hobbots/domain";
import { useQueries } from "@tanstack/react-query";
import { attemptActivityQuery, type LiveOutputs, liveOutputQuery } from "../../api/workbench.ts";
import { terminalAttempts } from "./terminal-model.ts";

/** What the Terminal replays across the tree, as far as it has been read. */
export interface TerminalActivity {
  /** The records of each replayed Attempt read so far. */
  readonly activities: ReadonlyArray<AttemptActivity>;
  /** What their running commands printed so far, by command. */
  readonly live: LiveOutputs;
  /**
   * How many other Tasks' records could not be read, so their commands are missing. The shown
   * Attempt's own read is the Workbench's, which says when it fails.
   */
  readonly unread: number;
  /** Reads those records again. */
  readonly retry: () => void;
}

/**
 * Reads the records the Terminal replays (#908): the shown Attempt's, and the latest Attempt's of
 * every other Task in the tree. Each is one Attempt's read, kept and refreshed as the Workbench
 * keeps it, and their live output comes from the event stream.
 */
export const useTerminalActivity = (tree: TaskTree, task: Task, shown: Attempt | null): TerminalActivity => {
  const attempts = terminalAttempts(tree, task, shown);
  const reads = useQueries({ queries: attempts.map((each) => attemptActivityQuery(each.id)) });
  const outputs = useQueries({ queries: attempts.map((each) => liveOutputQuery(each.id)) });
  const failed = reads.filter((read, index) => read.isError && attempts[index]?.id !== shown?.id);
  return {
    activities: reads.flatMap((read) => (read.data === undefined ? [] : [read.data])),
    live: Object.assign({}, ...outputs.map((output) => output.data ?? {})),
    unread: failed.length,
    retry: () => {
      for (const read of failed) void read.refetch();
    },
  };
};
