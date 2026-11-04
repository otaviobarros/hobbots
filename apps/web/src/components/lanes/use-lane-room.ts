import type { AttemptId, TaskTree } from "@hobbots/domain";
import { useQueries } from "@tanstack/react-query";
import { attemptActivityQuery } from "../../api/workbench.ts";
import { type LanePicks, type LaneRoom, laneAttempts, laneRoom } from "./lane-model.ts";

/** The try the address picked, by the Task it is a try of; none when it names no try of this tree. */
export const pickedTries = (tree: TaskTree, attemptId: AttemptId | undefined): LanePicks => {
  const picked = tree.attempts.find((each) => each.id === attemptId);
  return new Map(picked === undefined ? [] : [[picked.taskId, picked.id]]);
};

/**
 * The room's lanes, from the Task tree and the Workbench records of the tries they show. Each record
 * is read once and kept live as the hub records more, so a lane grows as its hob works; a record not
 * read yet leaves only what the tree itself says.
 */
export const useLaneRoom = (tree: TaskTree, picks: LanePicks): LaneRoom => {
  const reads = useQueries({ queries: laneAttempts(tree, picks).map((id) => attemptActivityQuery(id)) });
  const activities = reads.flatMap((each) => (each.data === undefined ? [] : [each.data]));
  return laneRoom(tree, activities, picks);
};
