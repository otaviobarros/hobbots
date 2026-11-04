import { DateTime, Schema } from "effect";
import { ApprovalId, type ApprovalRequest, ApprovalState, exactAction } from "./approval.ts";
import { ApprovalLifetime } from "./grant-rule.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { PolicyOperation } from "./policy.ts";
import { type Delegation, partyOf, type Quest, QuestId, type Question, QuestionId, QuestState } from "./quest.ts";
import { type Attempt, AttemptId, type Task, TaskId } from "./task.ts";

/**
 * A hob's History: what it did across all its chats, newest first, grouped by day. It is read from
 * the durable records of Tasks, Quests, approvals and questions, never from the event journal, which
 * keeps only a week. A lead's History also holds the work of the hobs it brought into its Quests.
 */

/** The Quest an event belongs to, for the line under it. */
export const HistoryQuest = Schema.Struct({ id: QuestId, goal: Schema.String });
export type HistoryQuest = typeof HistoryQuest.Type;

/** What every event carries: when, which hob, and where its Chat and Workbench open. */
const base = {
  /** Stable across reads: the event's kind and the record it comes from. */
  id: Schema.String,
  at: Schema.String,
  /** The hob that did it, or that asked you. */
  agentId: AgentId,
  taskId: Schema.NullOr(TaskId),
  threadId: Schema.NullOr(ThreadId),
  /** The Attempt the Workbench opens on, when there is one. */
  attemptId: Schema.NullOr(AttemptId),
  quest: Schema.NullOr(HistoryQuest),
};

/** You asked the hob for a piece of work in a chat. */
export const TaskAskedEvent = Schema.TaggedStruct("TaskAsked", { ...base, brief: Schema.String });
/** A lead gave the hob a Task on its Quest. */
export const TaskPickedUpEvent = Schema.TaggedStruct("TaskPickedUp", {
  ...base,
  brief: Schema.String,
  leadId: AgentId,
});
/** A Task the hob owned ended: its result, or why its last Attempt stopped. */
export const TaskEndedEvent = Schema.TaggedStruct("TaskEnded", {
  ...base,
  brief: Schema.String,
  state: Schema.Literals(["completed", "failed", "cancelled"]),
  summary: Schema.NullOr(Schema.String),
  /** How many Attempts it took: 0 when none started. */
  attempts: Schema.Int,
});
/** The hob started leading a Quest, with the hobs it brought in so far. */
export const QuestStartedEvent = Schema.TaggedStruct("QuestStarted", { ...base, party: Schema.Array(AgentId) });
/** A Quest the hob led ended with its Task. */
export const QuestEndedEvent = Schema.TaggedStruct("QuestEnded", { ...base, state: QuestState });
/** The hob asked you to approve an action: waiting, decided by you, or expired. */
export const ApprovalEvent = Schema.TaggedStruct("Approval", {
  ...base,
  approvalId: ApprovalId,
  state: ApprovalState,
  operation: PolicyOperation,
  label: Schema.String,
  /** The exact command, address or file, as the approval card shows it. */
  action: Schema.String,
  lifetime: Schema.NullOr(ApprovalLifetime),
  denyReason: Schema.NullOr(Schema.String),
});
/** A question no lead could answer reached you: open, or answered by you. */
export const QuestionEvent = Schema.TaggedStruct("Question", {
  ...base,
  questionId: QuestionId,
  text: Schema.String,
  answer: Schema.NullOr(Schema.String),
});

export const HistoryEvent = Schema.Union([
  TaskAskedEvent,
  TaskPickedUpEvent,
  TaskEndedEvent,
  QuestStartedEvent,
  QuestEndedEvent,
  ApprovalEvent,
  QuestionEvent,
]);
export type HistoryEvent = typeof HistoryEvent.Type;

/** The History tab's filters: Work, Your decisions and Quests split Everything three ways. */
export const HistoryFilter = Schema.Literals(["all", "work", "you", "quest"]);
export type HistoryFilter = typeof HistoryFilter.Type;
export type HistoryKind = Exclude<HistoryFilter, "all">;

/** Which filter an event falls under. */
export const historyKind = (event: HistoryEvent): HistoryKind => {
  switch (event._tag) {
    case "TaskAsked":
      return "you";
    case "TaskEnded":
      return "work";
    case "Approval":
      return event.state === "approved" || event.state === "denied" ? "you" : "work";
    case "Question":
      return event.answer === null ? "work" : "you";
    default:
      return "quest";
  }
};

/** Whether the event still waits for you: an approval or a question nobody has answered. */
export const historyNeedsYou = (event: HistoryEvent): boolean =>
  (event._tag === "Approval" && event.state === "pending") || (event._tag === "Question" && event.answer === null);

/** The records a hob's History is read from. */
export interface HistoryRecords {
  /** The Tasks you asked the hob for, those its leads gave it, and those it gave its own party. */
  readonly tasks: ReadonlyArray<Task>;
  /** The Delegations that gave any of `tasks` to its owner. */
  readonly delegations: ReadonlyArray<Delegation>;
  /** The Quests it leads, those it works on, and those on the top Tasks its approvals name. */
  readonly quests: ReadonlyArray<Quest>;
  /** The latest Attempt of each Task in `tasks` that ended. */
  readonly attempts: ReadonlyArray<Attempt>;
  /** Its own requests, and those of its party's Tasks. */
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  /** The questions about `tasks` that reached you. */
  readonly questions: ReadonlyArray<Question>;
}

const newestFirst = (a: HistoryEvent, b: HistoryEvent) =>
  Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Every event of `agentId`'s History in `records`, newest first. */
export const historyEvents = (agentId: AgentId, records: HistoryRecords): ReadonlyArray<HistoryEvent> => {
  const quests = new Map(records.quests.map((quest) => [quest.id, quest]));
  const questOnTask = new Map(records.quests.map((quest) => [quest.taskId, quest]));
  const delegated = new Map(records.delegations.map((delegation) => [delegation.childTaskId, delegation]));
  const attempts = new Map(records.attempts.map((attempt) => [attempt.id, attempt]));
  const tasks = new Map(records.tasks.map((task) => [task.id, task]));
  const short = (quest: Quest | undefined): HistoryQuest | null =>
    quest === undefined ? null : { id: quest.id, goal: quest.goal };
  // A member's Task serves the Quest that gave it; any other Task the Quest on it or on its top Task.
  const questOf = (taskId: TaskId | null, rootId: TaskId | null) => {
    if (taskId === null) return null;
    const delegation = delegated.get(taskId);
    if (delegation !== undefined) return short(quests.get(delegation.questId));
    return short(questOnTask.get(taskId) ?? (rootId === null ? undefined : questOnTask.get(rootId)));
  };
  const taskBase = (task: Task, id: string, at: string, attemptId: AttemptId | null) => ({
    id,
    at,
    agentId: task.ownerId,
    taskId: task.id,
    threadId: task.threadId,
    attemptId,
    quest: questOf(task.id, task.rootId),
  });

  // A Task that ended says its result, or why its last Attempt stopped, and how many Attempts it took.
  const endedOf = (task: Task): HistoryEvent | null => {
    if (task.state !== "completed" && task.state !== "failed" && task.state !== "cancelled") return null;
    const attemptId = task.result?.attemptId ?? task.currentAttemptId;
    const attempt = attemptId === null ? undefined : attempts.get(attemptId);
    return TaskEndedEvent.make({
      ...taskBase(task, `ended:${task.id}`, task.updatedAt, attemptId),
      brief: task.brief,
      state: task.state,
      summary: task.result?.summary ?? attempt?.outcome ?? null,
      attempts: attempt?.number ?? 0,
    });
  };

  const fromTask = (task: Task): ReadonlyArray<HistoryEvent> => {
    const events: Array<HistoryEvent> = [];
    const delegation = delegated.get(task.id);
    if (task.parentId === null && task.ownerId === agentId)
      events.push(
        TaskAskedEvent.make({ ...taskBase(task, `asked:${task.id}`, task.createdAt, null), brief: task.brief }),
      );
    if (delegation !== undefined)
      events.push(
        TaskPickedUpEvent.make({
          ...taskBase(task, `picked-up:${task.id}`, delegation.createdAt, null),
          brief: task.brief,
          leadId: delegation.leadId,
        }),
      );
    const ended = endedOf(task);
    if (ended !== null) events.push(ended);
    return events;
  };

  const fromQuest = (quest: Quest): ReadonlyArray<HistoryEvent> => {
    if (quest.leadId !== agentId) return [];
    const at = (id: string, when: string) => ({
      id,
      at: when,
      agentId: quest.leadId,
      taskId: quest.taskId,
      threadId: quest.threadId,
      attemptId: null,
      quest: short(quest),
    });
    const started = QuestStartedEvent.make({
      ...at(`quest-started:${quest.id}`, quest.createdAt),
      party: partyOf(quest, records.delegations),
    });
    return quest.endedAt === null || quest.state === "active"
      ? [started]
      : [started, QuestEndedEvent.make({ ...at(`quest-ended:${quest.id}`, quest.endedAt), state: quest.state })];
  };

  const fromApproval = (approval: ApprovalRequest): HistoryEvent =>
    ApprovalEvent.make({
      id: `approval:${approval.id}`,
      at: approval.decidedAt ?? approval.createdAt,
      agentId: approval.agentId,
      taskId: approval.taskId,
      threadId: approval.threadId,
      attemptId: null,
      quest: questOf(approval.taskId, approval.rootTaskId),
      approvalId: approval.id,
      state: approval.state,
      operation: approval.operation,
      label: approval.label,
      action: exactAction(approval),
      lifetime: approval.lifetime,
      denyReason: approval.denyReason,
    });

  const fromQuestion = (question: Question): ReadonlyArray<HistoryEvent> => {
    const task = tasks.get(question.taskId);
    const yours = question.answeredBy?._tag === "User";
    if (task === undefined || question.recipientId !== null || !(question.state === "open" || yours)) return [];
    return [
      QuestionEvent.make({
        ...taskBase(task, `question:${question.id}`, question.answeredAt ?? question.createdAt, null),
        agentId: question.askerId,
        questionId: question.id,
        text: question.text,
        answer: yours ? question.answer : null,
      }),
    ];
  };

  return [
    ...records.tasks.flatMap(fromTask),
    ...records.quests.flatMap(fromQuest),
    ...records.approvals.map(fromApproval),
    ...records.questions.flatMap(fromQuestion),
  ].sort(newestFirst);
};

/** How many days a History page holds when the client does not say. */
export const HISTORY_PAGE_DAYS = 3;

/** One day of a hob's History: the date where you are, and its events, newest first. */
export const HistoryDay = Schema.Struct({
  /** The calendar date in the reader's time zone, as `YYYY-MM-DD`. */
  day: Schema.String,
  events: Schema.Array(HistoryEvent),
});
export type HistoryDay = typeof HistoryDay.Type;

/** One page of days, newest first. */
export const HistoryPage = Schema.Struct({
  days: Schema.Array(HistoryDay),
  /** Pass as `before` for the next page: the time of the page's oldest event. Null on the last page. */
  before: Schema.NullOr(Schema.String),
  /** How many more days have events of the filter, for "Show N earlier days". */
  earlierDays: Schema.Int,
});
export type HistoryPage = typeof HistoryPage.Type;

export interface HistoryPageRequest {
  readonly timeZone: DateTime.TimeZone;
  readonly filter: HistoryFilter;
  /** Only events before this time (epoch milliseconds), from an earlier page's `before`. */
  readonly before: number | null;
  readonly days: number;
}

/**
 * The page of `events` (newest first) that `request` asks for: whole days in the reader's time zone,
 * so a day is never split across two pages.
 */
export const historyPage = (events: ReadonlyArray<HistoryEvent>, request: HistoryPageRequest): HistoryPage => {
  const days: Array<{ day: string; events: Array<HistoryEvent> }> = [];
  let earlierDays = 0;
  let last: string | null = null;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (request.filter !== "all" && historyKind(event) !== request.filter) continue;
    if (request.before !== null && !(at < request.before)) continue;
    const day = DateTime.formatIsoDate(DateTime.makeZonedUnsafe(at, { timeZone: request.timeZone }));
    if (day === last) {
      if (earlierDays === 0) days.at(-1)?.events.push(event);
      continue;
    }
    last = day;
    if (days.length < request.days) days.push({ day, events: [event] });
    else earlierDays++;
  }
  const oldest = days.at(-1)?.events.at(-1);
  return { days, before: earlierDays === 0 || oldest === undefined ? null : oldest.at, earlierDays };
};
