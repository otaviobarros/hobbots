import {
  type AgentId,
  isTerminalTask,
  type MemberWork,
  openThreadTask,
  type TaskId,
  type TaskTree,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import type { HobState } from "../../lib/hob-state.ts";
import { filterCounts, filterOf, type HobFilter } from "../hobs-page/hobs-page-model.ts";

/**
 * The chat a hob's peek opens: the one it is replying in, else the one it used last. Null when the
 * hob has no chats yet, so the peek starts a new one.
 */
export const peekThread = <T extends Pick<Thread, "id" | "updatedAt">>(
  threads: ReadonlyArray<T>,
  activity: Readonly<Record<string, "thinking" | "working">>,
): T | null =>
  threads.find((thread) => activity[thread.id] !== undefined) ??
  threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
  null;

/** Where the peek's Open Workbench goes: a Task and the chat whose Workbench shows it. */
export interface BenchTarget {
  readonly hobId: AgentId;
  readonly threadId: ThreadId;
  readonly taskId: TaskId;
}

/**
 * The Workbench a hob's peek opens: the Task its chat turns work on in `threadId`, else the open
 * Task it does on a Quest, shown in the Quest's own thread. Null when the hob works on no Task.
 */
export const peekBench = (
  hobId: AgentId,
  threadId: ThreadId | null,
  trees: ReadonlyArray<TaskTree>,
  work: ReadonlyArray<MemberWork>,
): BenchTarget | null => {
  const own = threadId === null ? undefined : openThreadTask(trees, hobId);
  if (own !== undefined && threadId !== null) return { hobId, threadId, taskId: own.top.id };
  const member = work.findLast((each) => !isTerminalTask(each.task.state));
  if (member?.threadAgentId != null && member.quest.threadId !== null) {
    return { hobId: member.threadAgentId, threadId: member.quest.threadId, taskId: member.task.id };
  }
  return null;
};

/**
 * The chips over the scene: All, then each family with hobs in it, with its count. The families
 * are the ones Your hobs filters by, so a chip and its page agree.
 */
export const sceneChips = (
  states: ReadonlyArray<HobState>,
): ReadonlyArray<{ readonly value: HobFilter; readonly count: number }> => {
  const counts = filterCounts(states.map((state) => ({ state })));
  return (["all", "needs", "working", "resting"] as const)
    .map((value) => ({ value, count: counts[value] }))
    .filter(({ value, count }) => value === "all" || count > 0);
};

/** Whether a hob in `state` stays lit under `filter`. */
export const inFilter = (state: HobState, filter: HobFilter): boolean => filter === "all" || filterOf(state) === filter;

/** The filter in force: a picked chip whose family has emptied falls back to All. */
export const activeFilter = (picked: HobFilter, chips: ReturnType<typeof sceneChips>): HobFilter =>
  chips.some((chip) => chip.value === picked) ? picked : "all";
