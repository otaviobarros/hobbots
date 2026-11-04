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

/** What the count chips on Home filter the scene to: every hob, or one state family. */
export type SceneFilter = "all" | "needs-you" | "working" | "resting";

const familyOf: Record<HobState, SceneFilter | null> = {
  "needs-you": "needs-you",
  waiting: "needs-you",
  working: "working",
  thinking: "working",
  idle: "resting",
  asleep: "resting",
  paused: "resting",
  // A hob that had a problem has no chip of its own, so only All shows it.
  failed: null,
};

/** Whether a hob in `state` stays lit under `filter`. */
export const inFilter = (state: HobState, filter: SceneFilter): boolean =>
  filter === "all" || familyOf[state] === filter;

/** The chips over the scene: All, then each family with hobs in it, with its count. */
export const sceneChips = (
  states: ReadonlyArray<HobState>,
): ReadonlyArray<{ readonly value: SceneFilter; readonly count: number }> => [
  { value: "all", count: states.length },
  ...(["needs-you", "working", "resting"] as const)
    .map((value) => ({ value, count: states.filter((state) => familyOf[state] === value).length }))
    .filter(({ count }) => count > 0),
];

/** The filter in force: a picked chip whose family has emptied falls back to All. */
export const activeFilter = (picked: SceneFilter, chips: ReturnType<typeof sceneChips>): SceneFilter =>
  chips.some((chip) => chip.value === picked) ? picked : "all";
