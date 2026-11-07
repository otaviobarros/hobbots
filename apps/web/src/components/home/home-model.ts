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
import type { ThreadActivity } from "../../api/activity.ts";
import { groupOf } from "../../lib/crew.ts";
import type { HobState } from "../../lib/hob-state.ts";
import { type QuestInProgress, workTone } from "../../lib/quest-work.ts";
import { filterCounts, filterOf, type HobFilter } from "../hobs-page/hobs-page-model.ts";
import { messages } from "./messages.ts";

/**
 * Home's summary line: how many hobs, who needs you, then who is working, in the crew's order.
 * "4 hobs. Ada and Pip need you. Aldric is working."
 */
export const homeSummary = (
  crew: ReadonlyArray<{ readonly hob: { readonly name: string }; readonly state: HobState }>,
): string => {
  if (crew.length === 0) return messages.summary.none;
  const names = (group: "needs-you" | "working") =>
    crew.filter((each) => groupOf(each.state) === group).map((each) => each.hob.name);
  const working = names("working");
  return [
    messages.summary.count({ count: crew.length }),
    messages.summary.needs({ names: names("needs-you") }),
    ...(working.length === 0 ? [] : [messages.summary.working({ names: working })]),
  ].join(" ");
};

/**
 * The chat a hob's peek opens: the one it is replying in, else the one it used last. Null when the
 * hob has no chats yet, so the peek starts a new one.
 */
export const peekThread = <T extends Pick<Thread, "id" | "updatedAt">>(
  threads: ReadonlyArray<T>,
  activity: Readonly<Record<string, ThreadActivity>>,
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

/** One row of Pick up where you left off: a chat, or a Quest in progress. */
export type PickUpRow<H, T> =
  | { readonly kind: "thread"; readonly hob: H; readonly thread: T; readonly at: string }
  | { readonly kind: "quest"; readonly group: QuestInProgress; readonly at: string };

/** How many rows Pick up where you left off shows. */
const PICK_UP_LIMIT = 5;

/** When a Quest last moved: its newest member Task, or when it started. */
const questMoved = (group: QuestInProgress): string =>
  [group.quest.createdAt, ...group.members.map((each) => each.task.updatedAt)].toSorted().at(-1) ??
  group.quest.createdAt;

/**
 * Recent chats and Quests in progress in one list, the most recently active first. A chat that
 * follows a Quest shows once, as that Quest.
 */
export const pickUpRows = <H, T extends Pick<Thread, "id" | "updatedAt">>(
  chats: ReadonlyArray<{ readonly hob: H; readonly thread: T }>,
  quests: ReadonlyArray<QuestInProgress>,
): ReadonlyArray<PickUpRow<H, T>> => {
  const questThreads = new Set(
    quests.flatMap((group) => (group.quest.threadId === null ? [] : [group.quest.threadId])),
  );
  const rows: Array<PickUpRow<H, T>> = [
    ...chats
      .filter(({ thread }) => !questThreads.has(thread.id))
      .map(({ hob, thread }) => ({ kind: "thread" as const, hob, thread, at: thread.updatedAt })),
    ...quests.map((group) => ({ kind: "quest" as const, group, at: questMoved(group) })),
  ];
  return rows.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, PICK_UP_LIMIT);
};

/** How far a Quest's party got, and how many of its members wait on you. */
export const questProgress = (group: QuestInProgress) => ({
  done: group.members.filter((each) => each.task.state === "completed").length,
  total: group.members.length,
  needs: group.members.filter((each) => workTone[each.task.state] === "needs").length,
});
