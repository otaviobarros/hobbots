import { Schema } from "effect";
import { ApprovalRequest } from "./approval.ts";
import { BackpackItem, type BackpackItemId } from "./backpack.ts";
import { Milestone, Question, type TaskRefusal, type TaskTree, TaskWait } from "./quest.ts";
import { descendantsOf, isTerminalTask, Task, TaskId } from "./task.ts";

/**
 * The responsibility ledger (ADR 019, IN-006): what still has to settle before a Task counts as
 * done. It is a read over the Task tree and the backpack, never a store of its own, so it cannot
 * disagree with them. `complete_task`'s completion gate and a Quest's closure read the same one.
 */

/** One thing that keeps a Task open. */
export const LedgerEntry = Schema.Union([
  /** A Task under it that has not ended. */
  Schema.TaggedStruct("Child", { task: Task }),
  /** A Task it comes after that has not completed. */
  Schema.TaggedStruct("Dependency", { task: Task }),
  /** A question about it or a Task under it that nobody answered yet. */
  Schema.TaggedStruct("Question", { question: Question }),
  /** Its owner's wait for Tasks under it, while the wait still holds. */
  Schema.TaggedStruct("Wait", { wait: TaskWait }),
  /** A milestone it promised and has not reached. */
  Schema.TaggedStruct("Milestone", { milestone: Milestone }),
  /** A tool call on its work that waits for your decision. */
  Schema.TaggedStruct("Approval", { approval: ApprovalRequest }),
  /** Something in its owner's backpack about it, or about a Task under it, not yet dealt with. */
  Schema.TaggedStruct("Item", { item: BackpackItem }),
]);
export type LedgerEntry = typeof LedgerEntry.Type;

export class ResponsibilityLedger extends Schema.Class<ResponsibilityLedger>("ResponsibilityLedger")({
  taskId: TaskId,
  /** Everything still open, in the order above: work first, then records, then the backpack. */
  open: Schema.Array(LedgerEntry),
}) {}

/**
 * A backpack item the completing turn carries: it was put into that turn, so finishing the Task
 * deals with it. `claim` is the turn's hold on it when a worker delivered it under a claim, or null
 * for an unclaimed item the turn was briefed with. The gate leaves out only a carried item whose
 * claim still holds, or that is still pending and unclaimed, and resolves it as consumed (ADR 019).
 */
export interface CarriedItem {
  readonly itemId: BackpackItemId;
  readonly claim: { readonly owner: string; readonly token: number } | null;
}

/** What the ledger is read from: the records as one transaction sees them. */
export interface LedgerSources {
  /** The Task and everything under it, with their records. */
  readonly subtree: TaskTree;
  /** Every Task in the Task's whole tree, for the siblings it comes after. */
  readonly tree: ReadonlyArray<Task>;
  /** Pending approval requests on the work. */
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  /** The owner's open actionable backpack items about the Task or a Task under it, less those the turn carries. */
  readonly items: ReadonlyArray<BackpackItem>;
}

const waitHolds = (wait: TaskWait, tasks: ReadonlyArray<Task>) => {
  const ended = wait.on.filter((id) => {
    const task = tasks.find((each) => each.id === id);
    return task !== undefined && isTerminalTask(task.state);
  });
  return wait.mode === "any" ? ended.length === 0 : ended.length < wait.on.length;
};

/**
 * An item the records already settle: a question is open exactly while its Question record is,
 * which the ledger lists, and a Task item asks to take up a Task, which has ended once the Task
 * has. What the ended Task left for its lead comes as its own result or failure item.
 */
const settledElsewhere = (item: BackpackItem, ended: ReadonlySet<string>) =>
  item.kind === "question" || (item.kind === "task" && item.taskId !== null && ended.has(item.taskId));

/** The ledger of `task`: everything still open on it, from the records in `sources`. Pure. */
export const responsibilityLedger = (task: Task, sources: LedgerSources): ResponsibilityLedger => {
  const under = descendantsOf(task, sources.subtree.tasks);
  const scope = new Set([task.id, ...under.map((each) => each.id)]);
  const done = new Set(sources.tree.filter((each) => each.state === "completed").map((each) => each.id));
  const ended = new Set<string>(under.filter((each) => isTerminalTask(each.state)).map((each) => each.id));
  const open: Array<LedgerEntry> = [
    ...under.filter((each) => !isTerminalTask(each.state)).map((each) => ({ _tag: "Child", task: each }) as const),
    ...sources.subtree.waits
      .filter((wait) => wait.taskId === task.id && waitHolds(wait, under))
      .map((wait) => ({ _tag: "Wait", wait }) as const),
    ...sources.tree
      .filter((each) => task.dependsOn.includes(each.id) && !done.has(each.id))
      .map((each) => ({ _tag: "Dependency", task: each }) as const),
    ...sources.subtree.questions
      .filter((question) => question.state === "open" && scope.has(question.taskId))
      .map((question) => ({ _tag: "Question", question }) as const),
    ...sources.subtree.milestones
      .filter((milestone) => milestone.taskId === task.id && milestone.reachedAt === null)
      .map((milestone) => ({ _tag: "Milestone", milestone }) as const),
    ...sources.approvals.map((approval) => ({ _tag: "Approval", approval }) as const),
    ...sources.items
      .filter((item) => item.taskId !== null && scope.has(item.taskId) && !settledElsewhere(item, ended))
      .map((item) => ({ _tag: "Item", item }) as const),
  ];
  return new ResponsibilityLedger({ taskId: task.id, open });
};

const REASONS: Record<LedgerEntry["_tag"], TaskRefusal> = {
  Child: "children-open",
  Wait: "children-open",
  Dependency: "dependencies-open",
  Question: "questions-open",
  Milestone: "milestones-open",
  Approval: "approvals-pending",
  Item: "items-open",
};

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";

const taskName = (task: Task) => `Task ${task.id} (${firstLine(task.brief)})`;

const describeItem = (item: BackpackItem): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "result":
      return `the result of ${taskName(payload.task)} is in your backpack, not yet read`;
    case "failure":
      return `${taskName(payload.task)} ${payload.task.state}, and you have not read it yet`;
    case "task":
      return `${taskName(payload.task)} has not been taken up`;
    case "question":
      return `question ${payload.question.id} waits for your answer: "${payload.question.text}"`;
    case "answer":
      return `the answer to question ${payload.question.id} is not yet read`;
    case "hand-off":
      return `the hand-off of "${payload.artifact.label}" is not yet read`;
    case "checkpoint":
      return `a ${payload.checkpoint.kind} reported on Task ${payload.checkpoint.taskId} is not yet read: ${payload.checkpoint.summary}`;
    default:
      return `a ${item.kind} item about Task ${item.taskId} is not yet dealt with`;
  }
};

/** One open entry, in words the hob can act on. */
export const describeLedgerEntry = (entry: LedgerEntry): string => {
  switch (entry._tag) {
    case "Child":
      return `${taskName(entry.task)} is ${entry.task.state}`;
    case "Wait":
      return `you wait for ${entry.wait.mode} of ${entry.wait.on.join(", ")}`;
    case "Dependency":
      return `it comes after ${taskName(entry.task)}, which is ${entry.task.state}`;
    case "Question":
      return `question ${entry.question.id} is unanswered: "${entry.question.text}"`;
    case "Milestone":
      return `milestone "${entry.milestone.title}" is not reached; report it with report_checkpoint`;
    case "Approval":
      return `a tool call waits for approval: ${entry.approval.label}`;
    case "Item":
      return describeItem(entry.item);
  }
};

/** How many open entries a refusal names before it counts the rest. */
const NAMED = 8;

/**
 * Why a Task cannot complete yet, naming each open entry, or null when its ledger is settled. A
 * final sentence alone never closes work: the gate reads the records, not the reply.
 */
export const ledgerRefusal = (
  ledger: ResponsibilityLedger,
): { readonly reason: TaskRefusal; readonly message: string } | null => {
  const [first] = ledger.open;
  if (first === undefined) return null;
  const named = ledger.open.slice(0, NAMED).map(describeLedgerEntry);
  const rest = ledger.open.length - named.length;
  const more = rest > 0 ? `; and ${rest} more` : "";
  return {
    reason: REASONS[first._tag],
    message: `Task ${ledger.taskId} cannot complete yet: ${named.join("; ")}${more}.`,
  };
};

/**
 * The open backpack items in `ledger` that a turn carries because its prompt shows them, picked by
 * `shows`, as unclaimed items. A worker that delivers under a claim passes its claim instead.
 */
export const carriedFrom = (
  ledger: ResponsibilityLedger,
  shows: (item: BackpackItem) => boolean,
): ReadonlyArray<CarriedItem> =>
  ledger.open.flatMap((entry) =>
    entry._tag === "Item" && shows(entry.item) ? [{ itemId: entry.item.id, claim: null }] : [],
  );
