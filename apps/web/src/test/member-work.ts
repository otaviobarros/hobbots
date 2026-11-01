import {
  AgentId,
  DEFAULT_QUEST_LIMITS,
  Delegation,
  DelegationId,
  MemberWork,
  Quest,
  QuestId,
  Task,
  TaskId,
  type TaskState,
  ThreadId,
} from "@hobbots/domain";

const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();

/** A Quest led by `lead`, started at `second`. */
export const quest = (id: string, lead: string, second = 0) =>
  new Quest({
    id: QuestId.make(id),
    taskId: TaskId.make(`${id}-top`),
    leadId: AgentId.make(lead),
    parentQuestId: null,
    threadId: ThreadId.make(`${id}-thread`),
    goal: `Goal of ${id}`,
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    depth: 1,
    state: "active",
    createdAt: at(second),
    endedAt: null,
    revision: 1,
  });

/** `member`'s Task on `on`, created at `second`. */
export const memberWork = (taskId: string, member: string, on: Quest, state: TaskState = "active", second = 1) =>
  new MemberWork({
    task: new Task({
      id: TaskId.make(taskId),
      ownerId: AgentId.make(member),
      parentId: on.taskId,
      rootId: on.taskId,
      threadId: on.threadId,
      brief: `Brief for ${taskId}`,
      state,
      dependsOn: [],
      result: null,
      currentAttemptId: null,
      createdAt: at(second),
      updatedAt: at(second),
      revision: 1,
    }),
    delegation: new Delegation({
      id: DelegationId.make(`d-${taskId}`),
      questId: on.id,
      leadId: on.leadId,
      memberId: AgentId.make(member),
      parentTaskId: on.taskId,
      childTaskId: TaskId.make(taskId),
      brief: `Brief for ${taskId}`,
      expectedOutput: null,
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
      createdAt: at(second),
    }),
    quest: on,
  });
