import {
  type AgentId,
  type Attempt,
  ancestorsOf,
  awaitsNewAttempt,
  deadlineOf,
  descendantsOf,
  type HobStanding,
  HUB_STOPPED_OUTCOME,
  isCancellingTask,
  isCompletedTask,
  isFailedAttempt,
  isFailedTask,
  isOverdue,
  isRoutedSupervision,
  isStoppedSupervision,
  isTaskToolName,
  isTerminalTask,
  isUsageLimitOutcome,
  liveAttemptOn,
  type Question,
  REFUSALS_LIMIT,
  SUPERVISED_RETRIES,
  Supervision,
  type SupervisionEvent,
  SupervisionMachine,
  type Task,
  type TaskId,
  TaskPauses,
  type TaskTree,
  usageResetOf,
  watching,
} from "@hobbots/domain";

/**
 * The supervisor's rules (#1447), as one pure decision over a Task tree: what it does about each
 * Task under the one you asked for, from the records alone. It never calls a model; every word it
 * writes is written here. Each act carries the Task's record as it stands once the act is done.
 */

/** What the supervisor reads to decide. */
export interface Facts {
  readonly tree: TaskTree;
  /** Its record of each Task it acted on before, by Task. */
  readonly records: ReadonlyMap<TaskId, Supervision>;
  /** Where each hob stands now, or null for one the hub no longer has. */
  readonly standing: (agentId: AgentId) => HobStanding | null;
  readonly at: string;
}

export type Act =
  /**
   * The Task passed its deadline: the turns running in it and under it stop, the work under it
   * ends, and it fails with `reason`, which its lead reads (deadline rule).
   */
  | {
      readonly _tag: "Stop";
      readonly task: Task;
      readonly reason: string;
      /** Whether this is the first time: a Stop a turn held up is made again, but its lead is told once. */
      readonly first: boolean;
      readonly record: Supervision;
    }
  /** A failed Task goes back in the queue for a new Attempt (bounded retry rule). */
  | { readonly _tag: "Retry"; readonly task: Task; readonly reason: string; readonly record: Supervision }
  /** An open Task fails with `reason`, which its lead reads, once the work under it has ended (allowance rule). */
  | { readonly _tag: "Fail"; readonly task: Task; readonly reason: string; readonly record: Supervision }
  /** A note from Hobbots on the Task for its nearest lead at work, once per `key`. */
  | {
      readonly _tag: "Tell";
      readonly task: Task;
      readonly key: string;
      readonly text: string;
      readonly record: Supervision;
    }
  /** A question that waits on someone who cannot answer goes on to the next lead up, or to you. */
  | { readonly _tag: "Route"; readonly question: Question; readonly from: AgentId; readonly record: Supervision }
  /** What the supervisor acted on was taken on again: it only keeps its record. */
  | { readonly _tag: "Clear"; readonly record: Supervision };

/** The record after `event`, or undefined when the record's state does not take it. */
const after = (record: Supervision, event: SupervisionEvent): Supervision | undefined => {
  const next = SupervisionMachine.transition(record, event);
  return next instanceof Supervision ? next : undefined;
};

const attemptOf = (task: Task, tree: TaskTree): Attempt | undefined =>
  tree.attempts.find((each) => each.id === task.currentAttemptId);

const cut = (text: string, limit = 300) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

/** Why an Attempt ended, in words for the lead. */
const outcomeOf = (attempt: Attempt) => cut(attempt.outcome ?? "its runtime gave no reason");

/** Whether the work above the Task goes on, so a retry has somewhere to deliver to. */
const aboveGoesOn = (task: Task, tree: TaskTree) =>
  ancestorsOf(task, tree.tasks).every((each) => !isTerminalTask(each.state) && !isCancellingTask(each.state));

/** Whether the Task is still to be worked on: not ended, not being cancelled, and not paused by you. */
export const isOpen = (task: Task) =>
  !isTerminalTask(task.state) && !isCancellingTask(task.state) && !TaskPauses.isPaused(task);

/**
 * A question about the Task that waits on a lead who cannot answer it now: one whose hob cannot
 * work, or whose own Task above has ended.
 */
const stuckQuestion = (task: Task, facts: Facts): Question | undefined =>
  facts.tree.questions.find((question) => {
    if (question.taskId !== task.id || question.state !== "open" || question.recipientId === null) return false;
    const lead = question.recipientId;
    const leading = ancestorsOf(task, facts.tree.tasks).some(
      (each) => each.ownerId === lead && !isTerminalTask(each.state),
    );
    return !leading || facts.standing(lead) !== "active";
  });

/**
 * The refused calls made on the Task, counting each try, and the latest few: only the hub's own
 * words, the tool's name and the refusal's code, never what the hob sent, so a note from Hobbots
 * carries nothing a hob wrote (SECURITY.md).
 */
const refusalsOn = (task: Task, tree: TaskTree) => {
  const refused = tree.refusals.filter((each) => each.taskId === task.id);
  const total = refused.reduce((sum, each) => sum + each.tries, 0);
  const latest = refused
    .slice(-3)
    .map(
      (each) =>
        `${isTaskToolName(each.tool) ? each.tool : "a tool it was not given"} (${each.reason}${each.tries > 1 ? `, ${each.tries} tries` : ""})`,
    );
  return { total, latest };
};

/** The deadline rule: the Task passed its deadline, and nothing above it did first. */
const deadline = (task: Task, record: Supervision, facts: Facts): Act | undefined => {
  const parent = facts.tree.tasks.find((each) => each.id === task.parentId);
  // The work under a Task that is stopped ends with it.
  if (parent !== undefined && isOverdue(parent, facts.tree, facts.at)) return undefined;
  const reason = `Task ${task.id} passed its deadline (${deadlineOf(task, facts.tree)}) before it was done, so Hobbots stopped it and the work under it. What it reported and returned so far stays on the Task. Delegate what is left again with a time limit it can meet, or do it yourself.`;
  const first = !isStoppedSupervision(record);
  const next = first
    ? after(record, { _tag: "Overdue", at: facts.at, attemptId: task.currentAttemptId, reason })
    : record;
  return next === undefined ? undefined : { _tag: "Stop", task, reason, first, record: next };
};

/**
 * What a lead or you did since the supervisor handed the Task on: a new Attempt started, or the
 * question it passed on no longer waits on anyone who cannot answer it.
 */
const cleared = (task: Task, record: Supervision, facts: Facts): Act | undefined => {
  const moved = isRoutedSupervision(record)
    ? stuckQuestion(task, facts) === undefined
    : awaitsNewAttempt(record) && task.currentAttemptId !== null && task.currentAttemptId !== record.attemptId;
  if (!moved) return undefined;
  const next = after(record, { _tag: "Cleared", at: facts.at });
  return next === undefined ? undefined : { _tag: "Clear", record: next };
};

/** The allowance rule: its hob's usage limit ended its turn, so nothing retries it before it refills. */
const allowance = (task: Task, attempt: Attempt, record: Supervision, facts: Facts): Act | undefined => {
  if (!isFailedAttempt(attempt.state) || !isUsageLimitOutcome(attempt.outcome)) return undefined;
  if (!isOpen(task) && !isFailedTask(task.state)) return undefined;
  const reset = usageResetOf(attempt.outcome);
  const reason = `The usage limit of hob ${task.ownerId}'s runtime ended its turn on Task ${task.id}${reset === null ? ", and the provider did not say when it resets" : `; it resets at ${reset}`}. Hobbots stopped it rather than try again before then. Retry it once the limit resets, or reassign it to a hob on another runtime.`;
  const next = after(record, { _tag: "AllowanceOut", at: facts.at, attemptId: attempt.id, reason });
  if (next === undefined) return undefined;
  return isFailedTask(task.state)
    ? { _tag: "Tell", task, key: `allowance:${attempt.id}`, text: reason, record: next }
    : { _tag: "Fail", task, reason, record: next };
};

/** The unknown-outcome rule: whether its last turn stopped, or what it did, is not known. */
const unknownOutcome = (task: Task, attempt: Attempt, record: Supervision, facts: Facts): Act | undefined => {
  const unresolved = attempt.state === "unresolved";
  // A step Hobbots stopped with the hub failed, since what it did is not known; a member's turn goes on in its session.
  const cutOff = attempt.state === "interrupted" && attempt.outcome === HUB_STOPPED_OUTCOME && isFailedTask(task.state);
  if ((!unresolved && !cutOff) || isCompletedTask(task.state)) return undefined;
  // Its hob's own reports stay on the Task, where read_tasks shows them as the hob's: a note from Hobbots carries only its own words.
  const reason = unresolved
    ? `Task ${task.id}'s last turn was asked to stop and never confirmed it did, so whether it changed anything after that is not known. Read what it reported with read_tasks. Hobbots will not start it again on its own: check its folders and branches before you retry or reassign it.`
    : `Hobbots stopped while Task ${task.id}'s turn ran, so what it did after its last report is not known. Read what it reported with read_tasks. Hobbots will not start it again on its own: check its folders and branches, then retry or reassign it.`;
  const next = after(record, { _tag: "OutcomeUnknown", at: facts.at, attemptId: attempt.id, reason });
  return next === undefined
    ? undefined
    : { _tag: "Tell", task, key: `unknown-outcome:${attempt.id}`, text: reason, record: next };
};

/**
 * The bounded retry rule. A failed Task whose turn failed is retried while the supervisor's budget
 * lasts, when its hob can work and the work above it goes on; past the budget its lead decides. An
 * open Task's failed turn is its dispatcher's to try again, within its own bound (IN-007).
 */
const failure = (task: Task, attempt: Attempt, record: Supervision, facts: Facts): Act | undefined => {
  if (!isFailedAttempt(attempt.state) || isUsageLimitOutcome(attempt.outcome)) return undefined;
  if (!aboveGoesOn(task, facts.tree) || !isFailedTask(task.state)) return undefined;
  // A paused hob's retry waits until it wakes; a retired or retiring one takes no work again.
  const standing = facts.standing(task.ownerId);
  const retryable = standing === "active" || standing === "paused";
  const tries = record.retries + 1;
  const reason = `Its turn failed (${outcomeOf(attempt)}), so Hobbots retried it: try ${tries} of ${SUPERVISED_RETRIES}.`;
  const next = after(record, { _tag: "Failed", at: facts.at, attemptId: attempt.id, retryable, reason });
  if (next === undefined) return undefined;
  // The machine counted another try only when it is within the budget.
  if (next.retries > record.retries) return { _tag: "Retry", task, reason, record: next };
  const text = retryable
    ? `Task ${task.id} failed again after Hobbots retried it ${record.retries} times: ${outcomeOf(attempt)}. Decide what comes next: retry it with what it needs, reassign it, or cancel it.`
    : `Task ${task.id} failed (${outcomeOf(attempt)}), and Hobbots cannot retry it, since hob ${task.ownerId} is ${standing ?? "gone"}. Reassign it, or cancel it.`;
  return {
    _tag: "Tell",
    task,
    key: `retries-spent:${attempt.id}`,
    text,
    record: new Supervision({ ...next, reason: text }),
  };
};

/** The refusals rule: the Task's hob made call after call the hub refused, so its lead is told. */
const refusals = (task: Task, record: Supervision, facts: Facts): Act | undefined => {
  if (isTerminalTask(task.state) || isCancellingTask(task.state)) return undefined;
  const { total, latest } = refusalsOn(task, facts.tree);
  if (total - record.refusalsSeen < REFUSALS_LIMIT) return undefined;
  const text = `Hobbots refused ${total - record.refusalsSeen} Task tool calls hob ${task.ownerId} made on Task ${task.id}. The latest: ${latest.join("; ")}. Check its brief and what it may do, and tell it what to do instead.`;
  // It keeps the Attempt it last acted on: refused calls decide nothing about how the turn ends.
  const next = after(record, { _tag: "Refused", at: facts.at, attemptId: record.attemptId, total, reason: text });
  return next === undefined ? undefined : { _tag: "Tell", task, key: `refusals:${total}`, text, record: next };
};

/** The missing-input rule: a question waits on someone who cannot answer it, so it goes on to who can. */
const missingInput = (task: Task, record: Supervision, facts: Facts): Act | undefined => {
  const question = stuckQuestion(task, facts);
  if (question === undefined || question.recipientId === null) return undefined;
  const reason = `Question ${question.id} waited on hob ${question.recipientId}, who cannot answer it now, so Hobbots passed it on.`;
  // It keeps the Attempt it last acted on: passing a question on decides nothing about the turn.
  const next = after(record, { _tag: "Routed", at: facts.at, attemptId: record.attemptId, reason });
  return next === undefined ? undefined : { _tag: "Route", question, from: question.recipientId, record: next };
};

/** What the supervisor does about one Task under the one you asked for, by the first rule that applies. */
const decideTask = (task: Task, facts: Facts): Act | undefined => {
  const record = facts.records.get(task.id) ?? watching(task, facts.at);
  if (isOverdue(task, facts.tree, facts.at)) return deadline(task, record, facts);
  const clear = cleared(task, record, facts);
  if (clear !== undefined) return clear;
  const attempt = attemptOf(task, facts.tree);
  // Nothing about an Attempt is acted on twice, nor while it runs.
  const fresh = attempt !== undefined && attempt.id !== record.attemptId && !liveAttemptOn(task, facts.tree);
  return (
    (fresh ? allowance(task, attempt, record, facts) : undefined) ??
    (fresh ? unknownOutcome(task, attempt, record, facts) : undefined) ??
    (fresh ? failure(task, attempt, record, facts) : undefined) ??
    refusals(task, record, facts) ??
    missingInput(task, record, facts)
  );
};

/** What the supervisor does now about each Task under the one you asked for: at most one act each. */
export const decide = (facts: Facts): ReadonlyArray<Act> =>
  facts.tree.tasks.flatMap((task) => {
    if (task.parentId === null) return [];
    const act = decideTask(task, facts);
    return act === undefined ? [] : [act];
  });

/**
 * The Tasks a Stop ends, deepest first, so each fails only once the work under it has: the Task and
 * every Task under it still open, those being cancelled left to end by their cancel.
 */
export const stopOrder = (task: Task, tree: TaskTree): ReadonlyArray<Task> => {
  const depth = (each: Task) => ancestorsOf(each, tree.tasks).length;
  return [task, ...descendantsOf(task, tree.tasks)]
    .filter((each) => !isTerminalTask(each.state) && !isCancellingTask(each.state))
    .sort((a, b) => depth(b) - depth(a));
};

/** The earliest deadline after `at` among the open Tasks of the tree, when the supervisor should look again. */
export const nextDeadline = (tree: TaskTree, at: string): number | null => {
  const now = Date.parse(at);
  const due = tree.tasks.flatMap((task) => {
    if (task.parentId === null || !isOpen(task)) return [];
    const when = deadlineOf(task, tree);
    return when === null || Date.parse(when) <= now ? [] : [Date.parse(when)];
  });
  return due.length === 0 ? null : Math.min(...due);
};
