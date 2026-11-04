import type { AgentId, AttemptId, TaskTree } from "@hobbots/domain";
import { useQueries } from "@tanstack/react-query";
import { attemptActivityQuery } from "../../api/workbench.ts";
import { type LanePicks, type LaneRoom, laneAttempts, laneRoom } from "./lane-model.ts";

/** The try the address picked, by the Task it is a try of; none when it names no try of this tree. */
export const pickedTries = (tree: TaskTree, attemptId: AttemptId | undefined): LanePicks => {
  const picked = tree.attempts.find((each) => each.id === attemptId);
  return new Map(picked === undefined ? [] : [[picked.taskId, picked.id]]);
};

/** Where the reads of a hob's Workbench records stand, for its lane to say so. */
export interface LaneReads {
  /** A record is still on its way. */
  readonly pending: boolean;
  /** A record could not be read: the lane shows what it has and says that more is missing. */
  readonly failed: boolean;
  /** Reads again the records that are pending or failed. */
  readonly retry: () => void;
}

/**
 * The room's lanes, from the Task tree and the Workbench records of the tries they show, and where
 * each hob's reads stand. Each record is read once and kept live as the hub records more, so a lane
 * grows as its hob works; a record not read yet, or that failed, leaves only what the tree says,
 * and its lane says why (STD-REACT-015).
 */
export const useLaneRoom = (
  tree: TaskTree,
  picks: LanePicks,
): { readonly room: LaneRoom; readonly reads: (hobId: AgentId) => LaneReads } => {
  const ids = laneAttempts(tree, picks);
  const results = useQueries({ queries: ids.map((id) => attemptActivityQuery(id)) });
  const activities = results.flatMap((each) => (each.data === undefined ? [] : [each.data]));
  const ownerOf = (id: AttemptId) => {
    const taskId = tree.attempts.find((each) => each.id === id)?.taskId;
    return tree.tasks.find((each) => each.id === taskId)?.ownerId;
  };
  const reads = (hobId: AgentId): LaneReads => {
    const own = results.filter((_, index) => {
      const id = ids[index];
      return id !== undefined && ownerOf(id) === hobId;
    });
    const unsettled = own.filter((each) => each.isPending || each.isError);
    return {
      pending: own.some((each) => each.isPending),
      failed: own.some((each) => each.isError),
      retry: () => {
        for (const each of unsettled) void each.refetch();
      },
    };
  };
  return { room: laneRoom(tree, activities, picks), reads };
};
