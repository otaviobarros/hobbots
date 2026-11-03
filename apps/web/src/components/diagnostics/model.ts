import type { QuestTrace, RecoveryError, StalledWork } from "@hobbots/api";
import type { Attempt, BackpackItem, Delegation, RuntimeHealth, Task } from "@hobbots/domain";
import { RUNTIME_NAMES } from "@hobbots/domain";
import { runtimeProblem } from "../../api/runtime-health.ts";
import { firstLine, formatAgo, formatCount, plural } from "../../lib/format.ts";
import { messages } from "./messages.ts";

/** A hob's name by id; one this hub no longer lists reads as "a hob". */
export type HobName = (id: string) => string;

/** What to do about a runtime, or null when it is ready. */
export const runtimeFix = (health: RuntimeHealth): string | null => {
  const problem = runtimeProblem(health);
  return problem === null ? null : messages.runtimeFix[problem]({ name: RUNTIME_NAMES[health.runtime] });
};

/** What stalled and what to do about it, in one sentence. */
export const stalledText = (stalled: StalledWork, hobName: HobName, now: Date = new Date()): string =>
  messages.stalled[stalled.kind]({ hob: hobName(stalled.agentId), since: formatAgo(stalled.since, now) });

export const recoveryText = (error: RecoveryError): string =>
  messages.recovery[error.step]({ tag: error.tag, message: error.message });

/** A journal entry's type in words; one this client does not know keeps its own name. */
export const eventLabel = (type: string): string => messages.events[type] ?? type;

export const triesText = (count: number): string =>
  plural(count, { one: messages.follow.tries.one, other: messages.follow.tries.other(formatCount(count)) });

/** A Task of the followed Quest, with where it sits in the tree and the records that follow it. */
export interface TraceRow {
  readonly task: Task;
  readonly title: string;
  readonly depth: number;
  readonly delegation: Delegation | undefined;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly items: ReadonlyArray<BackpackItem>;
}

/** The Quest's Tasks depth first, each under the Task it belongs to, oldest first among siblings. */
export const traceRows = (trace: QuestTrace): ReadonlyArray<TraceRow> => {
  const { tree } = trace;
  const ids = new Set(tree.tasks.map((task) => task.id));
  const children = (parentId: string | null) =>
    tree.tasks.filter((task) =>
      parentId === null ? task.parentId === null || !ids.has(task.parentId) : task.parentId === parentId,
    );
  const rows: Array<TraceRow> = [];
  const visit = (task: Task, depth: number) => {
    rows.push({
      task,
      title: firstLine(task.brief),
      depth,
      delegation: tree.delegations.find((each) => each.childTaskId === task.id),
      attempts: tree.attempts.filter((attempt) => attempt.taskId === task.id),
      items: trace.backpack.filter((item) => item.taskId === task.id),
    });
    for (const child of children(task.id)) visit(child, depth + 1);
  };
  for (const top of children(null)) visit(top, 0);
  return rows;
};
