import type { TaskId, TaskTree } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { workbenchTreeQuery } from "../../api/workbench.ts";
import { useWorkbenchStream } from "../../api/workbench-stream.ts";
import type { RoomView } from "../quest-room/room-search.ts";
import { type DockFilter, dockCounts, dockSources, dockStates, sameStates } from "./dock-model.ts";
import { questRoots } from "./shown-paths.ts";
import type { TabState } from "./workbench-model.ts";

/**
 * Whose work the dock shows: the lit lane's hob, or its one Task when Show in the Workbench asked
 * for it, and the Task its header names. A Task alone has one lane, so the dock names it as a lit
 * lane's Task is named.
 */
const dockScope = (tree: TaskTree, party: boolean, lit: TaskId | undefined, taskOnly: boolean) => {
  const named = lit ?? (party ? undefined : tree.tasks[0]?.id);
  const litTask = named === undefined ? undefined : tree.tasks.find((each) => each.id === named);
  const ownerId = lit === undefined ? undefined : tree.tasks.find((each) => each.id === lit)?.ownerId;
  const only: DockFilter | undefined =
    lit === undefined || ownerId === undefined ? undefined : taskOnly ? { taskId: lit } : { ownerId };
  return { litTask, ownerId, only };
};

/**
 * What the docked Workbench shows: the Quest's tree read in one call and kept live through its one
 * stream, narrowed to the lit lane's hob and to the try picked for each Task.
 */
export const useDockRead = (
  tree: TaskTree,
  /** Whether the Quest has more than one lane, one per hob. */
  party: boolean,
  lit: TaskId | undefined,
  view: RoomView,
) => {
  const top = tree.tasks[0];
  const topId = top?.id ?? ("" as TaskId);
  const read = useQuery({ ...workbenchTreeQuery(topId), enabled: top !== undefined });
  useWorkbenchStream(topId, read.data?.cursor);
  const { litTask, ownerId, only } = dockScope(tree, party, lit, view.taskOnly);
  const data = read.data;
  const sources = data === undefined ? [] : dockSources(tree, data.activity, view.attemptId, only);
  const unread: TabState = read.isError ? { kind: "unavailable", reason: "unread" } : { kind: "history" };
  return {
    top,
    ownerId,
    litTask,
    only,
    sources,
    roots: data === undefined ? [] : questRoots(tree, data.activity),
    states: data === undefined ? sameStates(unread) : dockStates(sources),
    counts: data === undefined ? null : dockCounts(sources),
    retry: () => void read.refetch(),
  };
};
