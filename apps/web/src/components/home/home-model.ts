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
