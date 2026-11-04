import {
  type AgentId,
  type AttemptId,
  ancestorsOf,
  type BackpackItemKind,
  type BackpackPayload,
  type CheckpointKind,
  type Delegation,
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
  /**
   * The blockers the change recorded with a Task's move to a Failure state, by Task: the reason the
   * hub moved it for, which its Failure item carries instead of a Checkpoint item of its own (#683).
   */
  readonly movedFor: ReadonlyMap<TaskId, string>;
}

const parentOf = (task: Task, trees: Trees) => (task.parentId === null ? undefined : trees.byId.get(task.parentId));

type Rule<Tag extends JournaledEvent["_tag"]> = (
  event: Extract<JournaledEvent, { readonly _tag: Tag }>,
  trees: Trees,
) => ReadonlyArray<Draft>;

/** The work a Task under another one is for its owner, at the version that gave it: the Task you asked for starts from your message. */
const workFor = (task: Task, delegation: Delegation | null): ReadonlyArray<Draft> =>
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

/** A Task delegated to a member or planned as a step goes to its owner. */
const taskCreated: Rule<"TaskCreated"> = ({ task, delegation }) => workFor(task, delegation);

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

/**
 * A Task that failed, was blocked or was cancelled goes to its parent's owner as a Failure. One you
 * retried or reassigned goes to its owner again, as the work it now has to do.
 */
const taskStateChanged: Rule<"TaskStateChanged"> = ({ task, attempt, control }, trees) => {
  if (control !== undefined) return workFor(task, control.delegation);
  const parent = parentOf(task, trees);
  // An Attempt moving on repeats the Task's state; only a move of the Task itself is news.
  if (parent === undefined || attempt !== null || !FAILURE_STATES.includes(task.state)) return [];
  const reason = trees.movedFor.get(task.id);
  return [
    {
      recipientId: parent.ownerId,
      task,
      attemptId: task.currentAttemptId,
      payload: { _tag: "failure", task, ...(reason === undefined ? {} : { reason }) },
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
  // The reason for a move to a Failure state comes with the Failure item, when that goes to the same lead.
  const withFailure = trees.movedFor.get(task.id) === checkpoint.summary && checkpoint.kind === "blocker";
  if (withFailure && parentOf(task, trees)?.ownerId === lead) return [];
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

/**
 * The Task a note is held under. A note's recipient holds it under the nearest Task, from the
 * note's own up, that it owns; when that is one of its own steps, the session that coordinates
 * the work is the one above its steps, so the note is held there and names the step it is about.
 */
const noteHeldUnder = (subject: Task, recipientId: AgentId, trees: Trees): Task => {
  const nearest = [subject, ...ancestorsOf(subject, trees.all)].find((each) => each.ownerId === recipientId);
  let held = nearest;
  for (let parent = held && parentOf(held, trees); parent?.ownerId === recipientId; parent = parentOf(parent, trees)) {
    held = parent;
  }
  return held === undefined || held === nearest ? subject : held;
};

/**
 * Your note on a Task goes to the hob it was left for, its nearest lead, as a message about that Task.
 * A lead's message goes to the member whose Task it leads (#574).
 */
const noteLeft: Rule<"NoteLeft"> = ({ note }, trees) => {
  const subject = trees.byId.get(note.taskId);
  if (subject === undefined) return [];
  const task = noteHeldUnder(subject, note.recipientId, trees);
  return [
    {
      recipientId: note.recipientId,
      task,
      attemptId: null,
      payload: {
        _tag: "message",
        senderId: note.senderId ?? null,
        text: note.text,
        ...(task === subject ? {} : { aboutTaskId: note.taskId }),
        noteId: note.id,
      },
      record: `note:${note.id}`,
      version: null,
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
  NoteLeft: noteLeft,
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
        taskId: approval.messageId === null ? approval.taskId : null,
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
 * The blocker a change recorded with each Task it moved to a Failure state: the reason it moved
 * for, as `moveTask` records it in the same change (#683).
 */
const movedFor = (events: ReadonlyArray<JournaledEvent>): ReadonlyMap<TaskId, string> => {
  const moved = new Set(
    events.flatMap((event) =>
      event._tag === "TaskStateChanged" && event.attempt === null && FAILURE_STATES.includes(event.task.state)
        ? [event.task.id]
        : [],
    ),
  );
  return new Map(
    events.flatMap((event) =>
      event._tag === "CheckpointRecorded" && event.checkpoint.kind === "blocker" && moved.has(event.checkpoint.taskId)
        ? [[event.checkpoint.taskId, event.checkpoint.summary] as const]
        : [],
    ),
  );
};

/**
 * The backpack items a change's journal events call for (ADR 019). Pure: the repository writes
 * the result in the same transaction as the change and its events, so an item exists exactly when
 * the change committed. Routine progress is recorded too; it simply never wakes its hob.
 */
export const backpackItemsFor = (
  events: ReadonlyArray<JournaledEvent>,
  context: BackpackContext,
): ReadonlyArray<NewBackpackItem> => {
  const trees: Trees = {
    byId: new Map(context.tasks.map((task) => [task.id, task])),
    all: context.tasks,
    movedFor: movedFor(events),
  };
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
        case "QuestionWithdrawn":
          return [event.question.taskId];
        case "NoteLeft":
          return [event.note.taskId];
        case "HandedOff":
          return [event.handOff.toTaskId];
        default:
          return [];
      }
    }),
  ),
];
