import type { TaskId, TaskTree } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { workbenchTreeQuery } from "../../api/workbench.ts";
import { useWorkbenchStream } from "../../api/workbench-stream.ts";
import { laneOf, type RoomLane } from "../quest-room/room-model.ts";
import type { RoomView } from "../quest-room/room-search.ts";
import { dockCounts, dockSources, dockStates, sameStates } from "./dock-model.ts";
import type { TabState } from "./workbench-model.ts";

/**
 * What the docked Workbench shows: the Quest's tree read in one call and kept live through its one
 * stream, narrowed to the lit lane's hob and to the try picked for each Task.
 */
export const useDockRead = (
  tree: TaskTree,
  lanes: ReadonlyArray<RoomLane>,
  lit: TaskId | undefined,
  view: RoomView,
) => {
  const top = tree.tasks[0];
  const topId = top?.id ?? ("" as TaskId);
  const read = useQuery({ ...workbenchTreeQuery(topId), enabled: top !== undefined });
  useWorkbenchStream(topId, read.data?.cursor);
  const lane = laneOf(lanes, lit);
  // A Task alone has one lane, so the dock names it as a lit lane's Task is named.
  const named = lit ?? (lanes.length === 1 ? top?.id : undefined);
  const litTask = named === undefined ? undefined : tree.tasks.find((each) => each.id === named);
  const data = read.data;
  const sources = data === undefined ? [] : dockSources(tree, data.activity, view.attemptId, lane?.ownerId);
  const unread: TabState = read.isError ? { kind: "unavailable", reason: "unread" } : { kind: "history" };
  return {
    top,
    lane,
    litTask,
    sources,
    states: data === undefined ? sameStates(unread) : dockStates(sources),
    counts: data === undefined ? null : dockCounts(sources),
    retry: () => void read.refetch(),
  };
};
