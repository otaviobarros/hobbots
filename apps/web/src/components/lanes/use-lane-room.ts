import type { AgentId, AttemptId, TaskId, TaskTree } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useBlockers } from "../../api/blockers.ts";
import { workbenchTreeQuery } from "../../api/workbench.ts";
import { useWorkbenchStream } from "../../api/workbench-stream.ts";
import { blockersOn } from "../blockers/blocker-model.ts";
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
 * Each hob's work on a quest, from the Task tree and the Workbench records of the tries it shows, and
 * where each hob's reads stand. The records come from the Quest's one Workbench read, kept live
 * through the tree's stream, so a hob's work grows as it works; while that read
 * is on its way or failed, a lane shows only what the tree says, and says why (STD-REACT-015). A
 * lane whose Task has stuck work says Stuck, as its card and the Inbox do (#1087).
 */
export const useLaneRoom = (
  tree: TaskTree,
  picks: LanePicks,
): { readonly room: LaneRoom; readonly reads: (hobId: AgentId) => LaneReads } => {
  const ids = new Set(laneAttempts(tree, picks));
  const stuck = new Set(
    blockersOn(useBlockers(), new Set(tree.tasks.map((task) => task.id))).flatMap((item) =>
      item.taskId === null ? [] : [item.taskId],
    ),
  );
  const topId = tree.tasks[0]?.id ?? ("" as TaskId);
  const read = useQuery({ ...workbenchTreeQuery(topId), enabled: tree.tasks.length > 0 });
  useWorkbenchStream(topId, read.data?.cursor);
  const activities = (read.data?.activity.attempts ?? [])
    .map((each) => each.activity)
    .filter((each) => ids.has(each.attempt.id));
  const reads = (hobId: AgentId): LaneReads => {
    const owns = tree.tasks.some((task) => task.ownerId === hobId);
    return {
      pending: owns && read.isPending,
      failed: owns && read.isError,
      retry: () => void read.refetch(),
    };
  };
  return { room: laneRoom(tree, activities, picks, stuck), reads };
};
