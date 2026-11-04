import {
  AgentId,
  ApprovalId,
  ApprovalRequest,
  Attempt,
  AttemptId,
  BackpackBlocker,
  BackpackItem,
  BackpackItemId,
  Checkpoint,
  CheckpointId,
  DEFAULT_QUEST_LIMITS,
  Delegation,
  DelegationId,
  Milestone,
  MilestoneId,
  Quest,
  QuestId,
  Question,
  QuestionId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";

/** The Black Friday Quest of ADR 018 as records, for tests: Aldric leads, Quill drafts the copy, Ada builds the campaign. */
export const ALDRIC = AgentId.make("aldric");
export const QUILL = AgentId.make("quill");
export const ADA = AgentId.make("ada");
export const THREAD = ThreadId.make("thread-bf");
export const CAMPAIGN = TaskId.make("campaign");
export const COPY = TaskId.make("copy");
export const BUILD = TaskId.make("build");
export const QUEST = QuestId.make("quest-bf");

const at = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, "0")}.000Z`;

export const task = (
  id: TaskId,
  fields: Partial<{
    ownerId: AgentId;
    parentId: TaskId | null;
    state: TaskState;
    brief: string;
    dependsOn: ReadonlyArray<TaskId>;
    revision: number;
    second: number;
  }> = {},
): Task =>
  new Task({
    id,
    ownerId: fields.ownerId ?? ALDRIC,
    parentId: fields.parentId === undefined ? (id === CAMPAIGN ? null : CAMPAIGN) : fields.parentId,
    rootId: CAMPAIGN,
    threadId: THREAD,
    brief: fields.brief ?? id,
    state: fields.state ?? "active",
    dependsOn: fields.dependsOn ?? [],
    result: null,
    currentAttemptId: null,
    createdAt: at(fields.second ?? 0),
    updatedAt: at(fields.second ?? 0),
    revision: fields.revision ?? 1,
  });

export const quest = (fields: Partial<{ state: Quest["state"]; revision: number }> = {}): Quest =>
  new Quest({
    id: QUEST,
    taskId: CAMPAIGN,
    leadId: ALDRIC,
    parentQuestId: null,
    threadId: THREAD,
    goal: "A Black Friday campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    depth: 1,
    state: fields.state ?? "active",
    createdAt: at(1),
    endedAt: null,
    revision: fields.revision ?? 2,
  });

export const delegation = (member: AgentId, child: TaskId, brief: string): Delegation =>
  new Delegation({
    id: DelegationId.make(`d-${child}`),
    questId: QUEST,
    leadId: ALDRIC,
    memberId: member,
    parentTaskId: CAMPAIGN,
    childTaskId: child,
    brief,
    expectedOutput: null,
    authority: { overrides: {}, folders: null },
    timeoutMs: null,
    createdAt: at(2),
  });

export const milestone = (taskId: TaskId, title: string, position: number, reached = false): Milestone =>
  new Milestone({
    id: MilestoneId.make(`m-${taskId}-${position}`),
    taskId,
    title,
    position,
    reachedAt: reached ? at(5) : null,
    createdAt: at(2),
  });

export const checkpoint = (taskId: TaskId, kind: Checkpoint["kind"], summary: string, revision: number): Checkpoint =>
  new Checkpoint({
    id: CheckpointId.make(`c-${revision}`),
    taskId,
    attemptId: null,
    source: kind === "started" || kind === "waiting" || kind === "done" ? "automatic" : "unplanned",
    kind,
    milestoneId: null,
    summary,
    createdAt: at(revision % 60),
    revision,
  });

export const question = (
  taskId: TaskId,
  askerId: AgentId,
  text: string,
  fields: Partial<Pick<Question, "recipientId" | "state" | "answer" | "answeredBy" | "revision" | "chain">> = {},
): Question =>
  new Question({
    id: QuestionId.make(`q-${taskId}`),
    taskId,
    askerId,
    recipientId: fields.recipientId === undefined ? ALDRIC : fields.recipientId,
    chain: fields.chain ?? [],
    text,
    state: fields.state ?? "open",
    answer: fields.answer ?? null,
    answeredBy: fields.answeredBy ?? null,
    createdAt: at(20),
    answeredAt: fields.state === "answered" ? at(25) : null,
    revision: fields.revision ?? 10,
  });

export const attempt = (taskId: TaskId, state: Attempt["state"]): Attempt =>
  new Attempt({
    id: AttemptId.make(`a-${taskId}`),
    taskId,
    number: 1,
    agentId: ALDRIC,
    runtime: "claude-code",
    sessionId: null,
    configVersion: 1,
    policyVersion: null,
    state,
    outcome: null,
    startedAt: at(3),
    endedAt: null,
  });

/** A request a member's turn made on its Task, which pauses that turn until you decide it (#698). */
export const memberApproval = (
  taskId: TaskId,
  agentId: AgentId,
  fields: Partial<{ state: ApprovalRequest["state"]; revision: number; second: number }> = {},
): ApprovalRequest =>
  new ApprovalRequest({
    id: ApprovalId.make(`ap-${taskId}`),
    agentId,
    threadId: THREAD,
    messageId: null,
    taskId,
    rootTaskId: CAMPAIGN,
    stepId: "tool-1",
    tool: "Bash",
    operation: "delete-files",
    targets: ["/work/scratch/tmp-notes.txt"],
    arguments: { command: "rm scratch/tmp-notes.txt" },
    label: "Running rm scratch/tmp-notes.txt",
    reason: "Deleting files asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1",
    state: fields.state ?? "pending",
    denyReason: null,
    createdAt: at(fields.second ?? 5),
    decidedAt: null,
    revision: fields.revision ?? 1,
  });

export const tree = (fields: Partial<ConstructorParameters<typeof TaskTree>[0]> = {}): TaskTree =>
  new TaskTree({
    tasks: [task(CAMPAIGN)],
    quests: [],
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints: [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
    ...fields,
  });

/** Aldric's Quest with Quill drafting and Ada waiting on Quill's copy. */
export const blackFriday = (): TaskTree =>
  tree({
    tasks: [
      task(CAMPAIGN, { brief: "Plan a Black Friday campaign" }),
      task(COPY, { ownerId: QUILL, brief: "Draft the landing copy", second: 2 }),
      task(BUILD, { ownerId: ADA, brief: "Build the campaign", state: "waiting", dependsOn: [COPY], second: 3 }),
    ],
    quests: [quest()],
    delegations: [delegation(QUILL, COPY, "Draft the landing copy"), delegation(ADA, BUILD, "Build the campaign")],
  });

/** Work Quill could not carry on with, waiting on you as a blocker (IN-007). */
/** An hour before the Quest, as the Inbox tests read it. */
const STUCK_AT = "2026-11-01T09:00:00.000Z";

export const stuckItem = (threadId: ThreadId | null, retired = false): BackpackItem =>
  new BackpackItem({
    id: BackpackItemId.make("b1"),
    recipientId: QUILL,
    kind: "message",
    actionable: true,
    priority: 1,
    state: "failed",
    taskId: COPY,
    questId: null,
    attemptId: null,
    threadId,
    dedupeKey: "b1",
    payload: { _tag: "message", senderId: null, text: "Hi" },
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    blockers: [
      new BackpackBlocker({
        number: 1,
        reason: retired ? "recipient-retired" : "retries-exhausted",
        nextAction: retired ? "dismiss" : "retry",
        diagnostic: null,
        lastEnd: null,
        afterDeliveries: 3,
        raisedAt: STUCK_AT,
        decision: null,
        decidedAt: null,
      }),
    ],
    disposition: null,
    error: null,
    createdAt: STUCK_AT,
    updatedAt: STUCK_AT,
    revision: 1,
  });
