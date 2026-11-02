import {
  type AgentId,
  type AttemptId,
  ancestorsOf,
  type BackpackItemKind,
  type BackpackPayload,
  type CheckpointKind,
  type JournaledEvent,
  leadsAbove,
  type NewBackpackItem,
  type Quest,
  type QuestId,
  type Question,
  type Task,
  type TaskId,
  type TaskState,
} from "@hobbots/domain";

/** The hob tool call a change was made by: its items take their dedupe key from the call's key (ADR 019). */
export interface ToolCallSource {
  readonly agentId: AgentId;
  readonly key: string;
}

/** What the change's events are read against: the trees they touch, as the change left them. */
export interface BackpackContext {
  readonly tasks: ReadonlyArray<Task>;
  readonly quests: ReadonlyArray<Quest>;
  /** The tool call the change was made by, or null for a change the hub or you made. */
  readonly toolCall: ToolCallSource | null;
  /**
   * Whether the approval requests the change decides or expires have no live turn waiting for
   * them, so each outcome goes to its hob's backpack (ADR 019), as when Hobbots restarted.
   */
  readonly approvalOutcomes?: boolean;
}

/** One item a rule makes, before the source and its key are added. */
interface Draft {
  readonly recipientId: AgentId;
  readonly task: Task;
  readonly attemptId: AttemptId | null;
  readonly payload: BackpackPayload;
  /** The record that caused it, as `<record>:<id>`, and its version when it has one. */
  readonly record: string;
  readonly version: number | null;
}

/** The Task states a Task's lead hears about as a Failure. */
const FAILURE_STATES: ReadonlyArray<TaskState> = ["failed", "blocked", "cancelled"];

/** Checkpoints a lead hears about as routine progress; the hub's ending ones come as Results and Failures. */
const PROGRESS: ReadonlyArray<CheckpointKind> = ["progress", "started", "waiting"];
const ENDING: ReadonlyArray<CheckpointKind> = ["done", "failed", "cancelled"];

/** The trees a change touched, with lookups the rules share. */
interface Trees {
  readonly byId: ReadonlyMap<TaskId, Task>;
  readonly all: ReadonlyArray<Task>;
}

const parentOf = (task: Task, trees: Trees) => (task.parentId === null ? undefined : trees.byId.get(task.parentId));

type Rule<Tag extends JournaledEvent["_tag"]> = (
  event: Extract<JournaledEvent, { readonly _tag: Tag }>,
  trees: Trees,
) => ReadonlyArray<Draft>;

/** A Task delegated to a member or planned as a step goes to its owner. The Task you asked for starts from your message. */
const taskCreated: Rule<"TaskCreated"> = ({ task, delegation }) =>
  task.parentId === null
    ? []
    : [
        {
          recipientId: task.ownerId,
          task,
          attemptId: null,
          payload: { _tag: "task", task, delegation },
          record: `task:${task.id}`,
          version: task.revision,
        },
      ];

/** A finished Task's result goes to its parent's owner. */
const taskCompleted: Rule<"TaskCompleted"> = ({ task, artifacts }, trees) => {
  const parent = parentOf(task, trees);
  if (parent === undefined) return [];
  return [
    {
      recipientId: parent.ownerId,
      task,
      attemptId: task.result?.attemptId ?? null,
      payload: { _tag: "result", task, artifacts },
      record: `task:${task.id}`,
      version: task.revision,
    },
  ];
};

/** A Task that failed, was blocked or was cancelled goes to its parent's owner as a Failure. */
const taskStateChanged: Rule<"TaskStateChanged"> = ({ task, attempt }, trees) => {
  const parent = parentOf(task, trees);
  // An Attempt moving on repeats the Task's state; only a move of the Task itself is news.
  if (parent === undefined || attempt !== null || !FAILURE_STATES.includes(task.state)) return [];
  return [
    {
      recipientId: parent.ownerId,
      task,
      attemptId: task.currentAttemptId,
      payload: { _tag: "failure", task },
      record: `task:${task.id}`,
      version: task.revision,
    },
  ];
};

/** A member's report goes to its nearest lead: routine progress as Progress, anything else as a Checkpoint. */
const checkpointRecorded: Rule<"CheckpointRecorded"> = ({ checkpoint }, trees) => {
  const task = trees.byId.get(checkpoint.taskId);
  const lead = task === undefined ? undefined : leadsAbove(task, trees.all)[0];
  if (task === undefined || lead === undefined || ENDING.includes(checkpoint.kind)) return [];
  const routine = PROGRESS.includes(checkpoint.kind);
  return [
    {
      recipientId: lead,
      task,
      attemptId: checkpoint.attemptId,
      payload: routine ? { _tag: "progress", checkpoint } : { _tag: "checkpoint", checkpoint },
      record: `checkpoint:${checkpoint.id}`,
      version: null,
    },
  ];
};

/** A question goes to the lead it is with now. One with no lead left is yours, in your Inbox. */
const questionTo = ({ question }: { readonly question: Question }, trees: Trees): ReadonlyArray<Draft> => {
  const task = trees.byId.get(question.taskId);
  if (task === undefined || question.recipientId === null) return [];
  return [
    {
      recipientId: question.recipientId,
      task,
      attemptId: task.currentAttemptId,
      payload: { _tag: "question", question },
      record: `question:${question.id}`,
      version: question.revision,
    },
  ];
};

/** An answer, from a lead or from you, goes to the hob that asked. */
const questionAnswered: Rule<"QuestionAnswered"> = ({ question }, trees) => {
  const task = trees.byId.get(question.taskId);
  if (task === undefined) return [];
  return [
    {
      recipientId: question.askerId,
      task,
      attemptId: task.currentAttemptId,
      payload: { _tag: "answer", question },
      record: `question:${question.id}`,
      version: question.revision,
    },
  ];
};

/** A hand-off goes to the owner of the Task that receives it. */
const handedOff: Rule<"HandedOff"> = ({ handOff, artifact }, trees) => {
  const task = trees.byId.get(handOff.toTaskId);
  if (task === undefined) return [];
  return [
    {
      recipientId: task.ownerId,
      task,
      attemptId: null,
      payload: { _tag: "hand-off", handOff, artifact },
      record: `hand-off:${handOff.artifactId}:${handOff.toTaskId}`,
      version: null,
    },
  ];
};

const RULES: { readonly [Tag in JournaledEvent["_tag"]]?: Rule<Tag> } = {
  TaskCreated: taskCreated,
  TaskCompleted: taskCompleted,
  TaskStateChanged: taskStateChanged,
  CheckpointRecorded: checkpointRecorded,
  QuestionAsked: questionTo,
  QuestionEscalated: questionTo,
  QuestionAnswered: questionAnswered,
  HandedOff: handedOff,
};

const drafts = (event: JournaledEvent, trees: Trees): ReadonlyArray<Draft> => {
  const rule = RULES[event._tag] as Rule<typeof event._tag> | undefined;
  return rule === undefined ? [] : rule(event as never, trees);
};

/**
 * The dedupe key of ADR 019. From a tool call: the call's key plus the item's role in it, its kind
 * and record at its version, so one call that makes several items keeps them apart. From any other change: the
 * source record and the version that caused the item.
 */
const dedupeKey = (
  draft: Pick<Draft, "record" | "version">,
  kind: BackpackItemKind,
  toolCall: ToolCallSource | null,
) => {
  const version = draft.version === null ? "" : `:v${draft.version}`;
  return toolCall === null
    ? `${draft.record}${version}:${kind}`
    : `tool:${toolCall.agentId}:${toolCall.key}:${kind}:${draft.record}${version}`;
};

/** The nearest Quest above a Task: the one its lead runs the work under. */
const questAbove = (task: Task, trees: Trees, quests: ReadonlyArray<Quest>): QuestId | null => {
  const byTask = new Map(quests.map((quest) => [quest.taskId, quest.id]));
  for (const above of ancestorsOf(task, trees.all)) {
    const quest = byTask.get(above.id);
    if (quest !== undefined) return quest;
  }
  return null;
};

/**
 * The outcome of an approval request no live turn waits for, for the hob that asked: in the thread
 * it asked in, or for a party member, on the Task its turn worked on.
 */
const approvalOutcomes = (events: ReadonlyArray<JournaledEvent>, toolCall: ToolCallSource | null) =>
  events.flatMap((event): ReadonlyArray<NewBackpackItem> => {
    if (event._tag !== "ApprovalResolved" || event.approval.state === "pending") return [];
    const { approval } = event;
    const draft = { record: `approval:${approval.id}`, version: null };
    return [
      {
        recipientId: approval.agentId,
        // A party member's request continues the session that works its Task; a chat turn's, its thread.
        taskId: approval.taskId,
        questId: null,
        attemptId: null,
        threadId: approval.threadId,
        dedupeKey: dedupeKey(draft, "approval-outcome", toolCall),
        payload: { _tag: "approval-outcome", approval },
        notBefore: null,
      },
    ];
  });

/**
 * The backpack items a change's journal events call for (ADR 019). Pure: the repository writes
 * the result in the same transaction as the change and its events, so an item exists exactly when
 * the change committed. Routine progress is recorded too; it simply never wakes its hob.
 */
export const backpackItemsFor = (
  events: ReadonlyArray<JournaledEvent>,
  context: BackpackContext,
): ReadonlyArray<NewBackpackItem> => {
  const trees: Trees = { byId: new Map(context.tasks.map((task) => [task.id, task])), all: context.tasks };
  const outcomes = context.approvalOutcomes === true ? approvalOutcomes(events, context.toolCall) : [];
  const fromTasks = events.flatMap((event) =>
    drafts(event, trees).map((draft) => ({
      recipientId: draft.recipientId,
      taskId: draft.task.id,
      questId: questAbove(draft.task, trees, context.quests),
      attemptId: draft.attemptId,
      threadId: draft.task.threadId,
      dedupeKey: dedupeKey(draft, draft.payload._tag, context.toolCall),
      payload: draft.payload,
      notBefore: null,
    })),
  );
  return [...fromTasks, ...outcomes];
};

/** The Tasks a change's events touch, so the repository knows which trees to read for `backpackItemsFor`. */
export const tasksTouched = (events: ReadonlyArray<JournaledEvent>): ReadonlyArray<TaskId> => [
  ...new Set(
    events.flatMap((event): ReadonlyArray<TaskId> => {
      switch (event._tag) {
        case "TaskCreated":
        case "TaskCompleted":
        case "TaskStateChanged":
          return [event.task.id];
        case "CheckpointRecorded":
          return [event.checkpoint.taskId];
        case "QuestionAsked":
        case "QuestionEscalated":
        case "QuestionAnswered":
          return [event.question.taskId];
        case "HandedOff":
          return [event.handOff.toTaskId];
        default:
          return [];
      }
    }),
  ),
];
