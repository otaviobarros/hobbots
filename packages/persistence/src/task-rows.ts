import {
  AgentId,
  ApprovalRequest,
  ArtifactRef,
  Attempt,
  Checkpoint,
  Delegation,
  descendantsOf,
  HandOff,
  isTerminalTask,
  MemberWork,
  Milestone,
  Quest,
  Question,
  RefusedCall,
  Task,
  TaskId,
  TaskNote,
  TaskTree,
  TaskWait,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { approvalRow } from "./approvals.ts";
import { byteOrder, oldestFirst } from "./order.ts";

// The stored shape of each record (migrations 0024 and 0025): JSON text columns, numbers that PostgreSQL
// reads as bigints, and a Task's result split into two columns.
export type Row = Record<string, unknown>;

export const json = (value: unknown) => (value == null ? null : JSON.parse(String(value)));
export const int = (value: unknown) => (value == null ? null : Number(value));

const fromRow = {
  task: (row: Row) => ({
    ...row,
    dependsOn: json(row.dependsOn),
    result: row.resultSummary == null ? null : { summary: row.resultSummary, attemptId: row.resultAttemptId },
    revision: int(row.revision),
  }),
  quest: (row: Row) => ({
    ...row,
    acceptance: json(row.acceptance),
    limits: json(row.limits),
    depth: int(row.depth),
    revision: int(row.revision),
  }),
  delegation: (row: Row) => ({ ...row, authority: json(row.authority), timeoutMs: int(row.timeoutMs) }),
  attempt: (row: Row) => ({ ...row, number: int(row.number), configVersion: int(row.configVersion) }),
  milestone: (row: Row) => ({ ...row, position: int(row.position) }),
  checkpoint: (row: Row) => ({ ...row, revision: int(row.revision) }),
  question: (row: Row) => ({
    ...row,
    chain: json(row.chain),
    answeredBy: json(row.answeredBy),
    options: json(row.options) ?? [],
    recommended: int(row.recommended),
    picked: int(row.picked),
    revision: int(row.revision),
  }),
  artifact: (row: Row) => row,
  handOff: (row: Row) => row,
  // `left_revision` only orders the notes (migration 0051).
  note: ({ leftRevision: _, ...row }: Row) => ({ ...row, revision: int(row.revision) }),
  wait: (row: Row) => ({ taskId: row.taskId, on: json(row.waitsOn), mode: row.mode, createdAt: row.createdAt }),
  refusal: (row: Row) => ({
    id: row.id,
    agentId: row.agentId,
    taskId: row.taskId,
    tool: row.tool,
    key: row.callKey,
    input: row.input,
    reason: row.reason,
    message: row.message,
    tries: int(row.tries),
    createdAt: row.createdAt,
    refusedAt: row.refusedAt,
  }),
  approval: approvalRow,
};

const decoders = {
  task: Schema.decodeUnknownEffect(Schema.Array(Task)),
  quest: Schema.decodeUnknownEffect(Schema.Array(Quest)),
  delegation: Schema.decodeUnknownEffect(Schema.Array(Delegation)),
  attempt: Schema.decodeUnknownEffect(Schema.Array(Attempt)),
  milestone: Schema.decodeUnknownEffect(Schema.Array(Milestone)),
  checkpoint: Schema.decodeUnknownEffect(Schema.Array(Checkpoint)),
  question: Schema.decodeUnknownEffect(Schema.Array(Question)),
  artifact: Schema.decodeUnknownEffect(Schema.Array(ArtifactRef)),
  handOff: Schema.decodeUnknownEffect(Schema.Array(HandOff)),
  note: Schema.decodeUnknownEffect(Schema.Array(TaskNote)),
  wait: Schema.decodeUnknownEffect(Schema.Array(TaskWait)),
  refusal: Schema.decodeUnknownEffect(Schema.Array(RefusedCall)),
  approval: Schema.decodeUnknownEffect(Schema.Array(ApprovalRequest)),
};

interface Records {
  readonly task: Task;
  readonly quest: Quest;
  readonly delegation: Delegation;
  readonly attempt: Attempt;
  readonly milestone: Milestone;
  readonly checkpoint: Checkpoint;
  readonly question: Question;
  readonly artifact: ArtifactRef;
  readonly handOff: HandOff;
  readonly note: TaskNote;
  readonly wait: TaskWait;
  readonly refusal: RefusedCall;
  readonly approval: ApprovalRequest;
}

/** Decodes stored rows as records of `kind`. A row that does not decode is a defect: the hub wrote it. */
export const decodeRows =
  <K extends keyof Records>(kind: K) =>
  (rows: ReadonlyArray<Row>): Effect.Effect<ReadonlyArray<Records[K]>> =>
    (decoders[kind](rows.map(fromRow[kind])) as Effect.Effect<ReadonlyArray<Records[K]>, Schema.SchemaError>).pipe(
      Effect.orDie,
    );

// Text sorts byte by byte on both dialects, as `oldestFirst` does; numbers follow.
const orderBy = byteOrder;

/** The columns a Task is stored with. */
export const taskColumns = (task: Task) => ({
  id: task.id,
  owner_id: task.ownerId,
  parent_id: task.parentId,
  root_id: task.rootId,
  thread_id: task.threadId,
  brief: task.brief,
  state: task.state,
  depends_on: JSON.stringify(task.dependsOn),
  result_summary: task.result?.summary ?? null,
  result_attempt_id: task.result?.attemptId ?? null,
  current_attempt_id: task.currentAttemptId,
  created_at: task.createdAt,
  updated_at: task.updatedAt,
  revision: task.revision,
});

/** Reads of Task records, inside or outside a writing transaction. */
export const makeTaskReads = (sql: SqlClient.SqlClient) => {
  const oldest = oldestFirst(sql);
  const task = (id: string) => sql<Row>`SELECT * FROM tasks WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows("task")));
  /** Every Task in the tree whose root is `rootId`, oldest first. */
  const treeOf = (rootId: string) =>
    sql<Row>`SELECT * FROM tasks WHERE root_id = ${rootId} ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("task")));
  const questsOn = (taskIds: ReadonlyArray<string>) =>
    sql<Row>`SELECT * FROM quests WHERE ${sql.in("task_id", taskIds)} ORDER BY ${oldest}`.pipe(
      Effect.flatMap(decodeRows("quest")),
    );
  const quest = (id: string) =>
    sql<Row>`SELECT * FROM quests WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows("quest")));
  const attempt = (id: string) =>
    sql<Row>`SELECT * FROM attempts WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows("attempt")));
  const question = (id: string) =>
    sql<Row>`SELECT * FROM questions WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows("question")));

  /** The questions about a Task that nobody answered yet, oldest first. */
  const openQuestionsOn = (taskId: string) =>
    sql<Row>`SELECT * FROM questions WHERE task_id = ${taskId} AND state = 'open' ORDER BY ${oldest}`.pipe(
      Effect.flatMap(decodeRows("question")),
    );
  const note = (id: string) =>
    sql<Row>`SELECT * FROM task_notes WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows("note")));
  /**
   * The latest note to `recipientId` among the backpack items `itemIds` (#900): what a turn that
   * carries them picked up from its own lead, and passes on with any note it sends.
   */
  const carriedNote = (itemIds: ReadonlyArray<string>, recipientId: string) =>
    Effect.gen(function* () {
      if (itemIds.length === 0) return undefined;
      const rows = yield* sql<{ readonly payload: string }>`SELECT payload FROM backpack_items
        WHERE ${sql.in("id", itemIds)} AND kind = 'message' AND recipient_id = ${recipientId}`;
      const noteIds = rows.flatMap((row) => {
        const payload: { readonly noteId?: unknown } = JSON.parse(row.payload);
        return typeof payload.noteId === "string" ? [payload.noteId] : [];
      });
      if (noteIds.length === 0) return undefined;
      const [latest] = yield* sql<Row>`SELECT * FROM task_notes
        WHERE ${sql.in("id", noteIds)} AND recipient_id = ${recipientId}
        ORDER BY left_revision DESC LIMIT 1`.pipe(Effect.flatMap(decodeRows("note")));
      return latest;
    });
  /** The questions that climbed every lead and wait for you, oldest first, each with the Task it asks about. */
  const waitingQuestions = Effect.gen(function* () {
    const questions = yield* sql<Row>`SELECT * FROM questions WHERE recipient_id IS NULL AND state = 'open'
      ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("question")));
    if (questions.length === 0) return [];
    const tasks = yield* sql<Row>`SELECT * FROM tasks WHERE ${sql.in(
      "id",
      questions.map((each) => each.taskId),
    )}`.pipe(Effect.flatMap(decodeRows("task")));
    const roots = yield* sql<Row>`SELECT * FROM tasks WHERE ${sql.in(
      "id",
      tasks.map((each) => each.rootId),
    )}`.pipe(Effect.flatMap(decodeRows("task")));
    const byId = new Map([...tasks, ...roots].map((each) => [each.id, each]));
    // A question about work that ended waits for nobody: its asker is gone.
    const open = (id: TaskId) => {
      const each = byId.get(id);
      return each !== undefined && !isTerminalTask(each.state);
    };
    return questions.flatMap((question) => {
      const task = byId.get(question.taskId);
      return task === undefined || !open(task.id) || !open(task.rootId) ? [] : [{ question, task }];
    });
  });
  /** The hob each record's thread belongs to, by thread id. */
  const threadOwners = (records: ReadonlyArray<{ readonly threadId: string | null }>) =>
    Effect.gen(function* () {
      const threadIds = [...new Set(records.flatMap((each) => (each.threadId === null ? [] : [each.threadId])))];
      const owners =
        threadIds.length === 0
          ? []
          : yield* sql<{ readonly id: string; readonly agentId: string }>`SELECT id, agent_id FROM threads
              WHERE ${sql.in("id", threadIds)}`;
      return new Map(owners.map((each) => [each.id, AgentId.make(each.agentId)]));
    });
  /**
   * Members' Tasks that failed while their top Task is still under way, oldest first, each with the
   * hob whose chat the work was asked in (ADR 027). A top Task that failed is the lead's own reply.
   */
  const failedTasks = Effect.gen(function* () {
    const failed = yield* sql<Row>`SELECT * FROM tasks WHERE state = 'failed' AND parent_id IS NOT NULL
      ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("task")));
    if (failed.length === 0) return [];
    const roots = yield* sql<Row>`SELECT * FROM tasks WHERE ${sql.in("id", [
      ...new Set(failed.map((each) => each.rootId)),
    ])}`.pipe(Effect.flatMap(decodeRows("task")));
    const open = new Set(roots.flatMap((root) => (isTerminalTask(root.state) ? [] : [root.id])));
    const waiting = failed.filter((each) => open.has(each.rootId));
    const ownerOf = yield* threadOwners(waiting);
    return waiting.map((task) => ({
      task,
      leadId: task.threadId === null ? null : (ownerOf.get(task.threadId) ?? null),
    }));
  });
  const artifact = (id: string) =>
    sql<Row>`SELECT * FROM artifact_refs WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows("artifact")));

  /** The Task `id` and every Task under it: the Task first, then oldest first. */
  const subtree = (id: TaskId) =>
    Effect.gen(function* () {
      const [top] = yield* task(id);
      if (top === undefined) return null;
      return [top, ...descendantsOf(top, yield* treeOf(top.rootId))];
    });

  const readTree = (id: TaskId) =>
    Effect.gen(function* () {
      const tasks = yield* subtree(id);
      if (tasks === null) return null;
      const ids = tasks.map((each) => each.id);
      const inTree = (column: string) => sql.in(column, ids);
      const quests = yield* questsOn(ids);
      return new TaskTree({
        tasks,
        quests,
        delegations:
          yield* sql<Row>`SELECT * FROM delegations WHERE ${inTree("child_task_id")} ORDER BY ${oldest}`.pipe(
            Effect.flatMap(decodeRows("delegation")),
          ),
        attempts: yield* sql<Row>`SELECT * FROM attempts WHERE ${inTree("task_id")}
          ORDER BY ${orderBy(sql, ["task_id"], ["number"])}`.pipe(Effect.flatMap(decodeRows("attempt"))),
        milestones: yield* sql<Row>`SELECT * FROM milestones WHERE ${inTree("task_id")}
          ORDER BY ${orderBy(sql, ["task_id"], ["position"])}`.pipe(Effect.flatMap(decodeRows("milestone"))),
        // In the order they were journaled: several can share a time.
        checkpoints: yield* sql<Row>`SELECT * FROM checkpoints WHERE ${inTree("task_id")} ORDER BY revision`.pipe(
          Effect.flatMap(decodeRows("checkpoint")),
        ),
        questions: yield* sql<Row>`SELECT * FROM questions WHERE ${inTree("task_id")} ORDER BY ${oldest}`.pipe(
          Effect.flatMap(decodeRows("question")),
        ),
        artifacts: yield* sql<Row>`SELECT * FROM artifact_refs WHERE ${inTree("task_id")} ORDER BY ${oldest}`.pipe(
          Effect.flatMap(decodeRows("artifact")),
        ),
        handOffs: yield* sql<Row>`SELECT * FROM hand_offs WHERE ${inTree("to_task_id")}
          ORDER BY ${orderBy(sql, ["created_at", "artifact_id", "to_task_id"])}`.pipe(
          Effect.flatMap(decodeRows("handOff")),
        ),
        // In the order they were left: a pick-up changes a note's revision (#900).
        notes: yield* sql<Row>`SELECT * FROM task_notes WHERE ${inTree("task_id")} ORDER BY left_revision`.pipe(
          Effect.flatMap(decodeRows("note")),
        ),
        waits: yield* sql<Row>`SELECT * FROM task_waits WHERE ${inTree("task_id")}
          ORDER BY ${orderBy(sql, ["created_at", "task_id"])}`.pipe(Effect.flatMap(decodeRows("wait"))),
        refusals: yield* sql<Row>`SELECT * FROM task_tool_refusals WHERE ${inTree("task_id")} ORDER BY ${oldest}`.pipe(
          Effect.flatMap(decodeRows("refusal")),
        ),
        approvals: yield* sql<Row>`SELECT * FROM approval_requests WHERE ${inTree("task_id")} AND state = 'pending'
          ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("approval"))),
      });
    });

  /** The trees of the Tasks a thread's requests started, oldest first. */
  const threadTrees = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const tops = yield* sql<Row>`SELECT * FROM tasks WHERE thread_id = ${threadId} AND parent_id IS NULL
        ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("task")));
      const trees: Array<TaskTree> = [];
      for (const top of tops) {
        const tree = yield* readTree(top.id);
        if (tree !== null) trees.push(tree);
      }
      return trees;
    });

  /** A member's Tasks on active Quests, each with its Delegation and Quest, oldest first. */
  const memberWork = (agentId: string) =>
    Effect.gen(function* () {
      const delegations = yield* sql<Row>`SELECT * FROM delegations WHERE member_id = ${agentId}`.pipe(
        Effect.flatMap(decodeRows("delegation")),
      );
      if (delegations.length === 0) return [];
      const quests = yield* sql<Row>`SELECT * FROM quests WHERE state = 'active'
        AND ${sql.in("id", [...new Set(delegations.map((each) => each.questId))])}`.pipe(
        Effect.flatMap(decodeRows("quest")),
      );
      const active = new Map(quests.map((each) => [each.id, each]));
      const open = delegations.filter((each) => active.has(each.questId));
      if (open.length === 0) return [];
      const tasks = yield* sql<Row>`SELECT * FROM tasks WHERE ${sql.in(
        "id",
        open.map((each) => each.childTaskId),
      )} ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("task")));
      const byTask = new Map(open.map((each) => [each.childTaskId, each]));
      // A nested Quest's lead is a member, but its thread belongs to the hob the request was made to.
      const ownerOf = yield* threadOwners(quests);
      return tasks.flatMap((task) => {
        const delegation = byTask.get(task.id);
        const quest = delegation && active.get(delegation.questId);
        if (!delegation || !quest) return [];
        const threadAgentId = quest.threadId === null ? null : (ownerOf.get(quest.threadId) ?? null);
        return [new MemberWork({ task, delegation, quest, threadAgentId })];
      });
    });

  /**
   * The records of a hob's History: the Tasks you asked it for and those its leads gave it, the Tasks
   * it gave its party, their Delegations, Quests and latest Attempts, its own approval requests and its
   * party's, and the questions about those Tasks that reached you. Steps are left out: their work
   * shows on the Task they serve.
   */
  const historyRecords = (agentId: string) =>
    Effect.gen(function* () {
      const tasks = yield* sql<Row>`SELECT * FROM tasks WHERE
        (owner_id = ${agentId} AND (parent_id IS NULL
          OR id IN (SELECT child_task_id FROM delegations WHERE member_id = ${agentId})))
        OR id IN (SELECT child_task_id FROM delegations WHERE lead_id = ${agentId})
        ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("task")));
      const ids = tasks.map((each) => each.id);
      const delegations =
        ids.length === 0
          ? []
          : yield* sql<Row>`SELECT * FROM delegations WHERE ${sql.in("child_task_id", ids)} ORDER BY ${oldest}`.pipe(
              Effect.flatMap(decodeRows("delegation")),
            );
      const approvals = yield* sql<Row>`SELECT * FROM approval_requests WHERE agent_id = ${agentId}
        OR task_id IN (SELECT child_task_id FROM delegations WHERE lead_id = ${agentId})
        ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("approval")));
      const roots = [
        ...new Set([
          ...tasks.map((each) => each.rootId),
          ...approvals.flatMap((each) => (each.rootTaskId === null ? [] : [each.rootTaskId])),
        ]),
      ];
      const questIds = [...new Set(delegations.map((each) => each.questId))];
      const quests = yield* sql<Row>`SELECT * FROM quests WHERE lead_id = ${agentId}
        ${roots.length === 0 ? sql`` : sql`OR ${sql.in("task_id", roots)}`}
        ${questIds.length === 0 ? sql`` : sql`OR ${sql.in("id", questIds)}`}
        ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("quest")));
      const ended = tasks.flatMap((each) =>
        isTerminalTask(each.state) && each.currentAttemptId !== null ? [each.currentAttemptId] : [],
      );
      const attempts =
        ended.length === 0
          ? []
          : yield* sql<Row>`SELECT * FROM attempts WHERE ${sql.in("id", ended)}`.pipe(
              Effect.flatMap(decodeRows("attempt")),
            );
      const questions =
        ids.length === 0
          ? []
          : yield* sql<Row>`SELECT * FROM questions WHERE recipient_id IS NULL AND ${sql.in("task_id", ids)}
              ORDER BY ${oldest}`.pipe(Effect.flatMap(decodeRows("question")));
      const owners = yield* threadOwners([...tasks, ...quests, ...approvals]);
      return { tasks, delegations, quests, attempts, approvals, questions, threadOwners: owners };
    });

  /** Steps waiting to start: queued Tasks whose parent has the same owner and has not ended, oldest first. */
  const queuedSteps = sql<Row>`SELECT t.* FROM tasks t JOIN tasks p ON p.id = t.parent_id
    WHERE t.state = 'queued' AND p.owner_id = t.owner_id
      AND p.state NOT IN ('completed', 'failed', 'cancelled', 'cancelling')
    ORDER BY ${orderBy(sql, ["t.created_at", "t.id"])}`.pipe(Effect.flatMap(decodeRows("task")));
  /** Tasks whose cancel is not confirmed yet, oldest first. */
  const cancelling = sql<Row>`SELECT * FROM tasks WHERE state = 'cancelling'
    ORDER BY ${orderBy(sql, ["created_at", "id"])}`.pipe(Effect.flatMap(decodeRows("task")));
  /** The Delegation that brought a member its Task, if it was delegated. */
  const delegationsOf = (taskId: string) =>
    sql<Row>`SELECT * FROM delegations WHERE child_task_id = ${taskId}`.pipe(Effect.flatMap(decodeRows("delegation")));
  /** The top Tasks of work still going on, with a Task that has an Attempt: where members may be at work. */
  const rootsAtWork = sql<{ readonly rootId: string }>`SELECT DISTINCT root_id FROM tasks
    WHERE state NOT IN ('completed', 'failed', 'cancelled') AND current_attempt_id IS NOT NULL
    ORDER BY root_id`.pipe(Effect.map((rows) => rows.map((row) => TaskId.make(row.rootId))));
  const liveAttempts = sql<Row>`SELECT * FROM attempts WHERE state IN ('starting', 'running')
    ORDER BY ${orderBy(sql, ["started_at", "id"])}`.pipe(Effect.flatMap(decodeRows("attempt")));
  /**
   * Steps that started and have not ended, with no live Attempt: their session ended, oldest first.
   * A blocked step is not among them: it stopped on a finding and waits for its owner (#667).
   */
  const strandedSteps = sql<Row>`SELECT t.* FROM tasks t JOIN tasks p ON p.id = t.parent_id
    LEFT JOIN attempts a ON a.id = t.current_attempt_id
    WHERE t.state IN ('active', 'waiting', 'cancelling') AND p.owner_id = t.owner_id
      AND (a.id IS NULL OR a.state NOT IN ('starting', 'running'))
    ORDER BY ${orderBy(sql, ["t.created_at", "t.id"])}`.pipe(Effect.flatMap(decodeRows("task")));

  return {
    task,
    treeOf,
    questsOn,
    quest,
    attempt,
    question,
    note,
    carriedNote,
    waitingQuestions,
    failedTasks,
    openQuestionsOn,
    artifact,
    readTree,
    threadTrees,
    memberWork,
    historyRecords,
    queuedSteps,
    strandedSteps,
    cancelling,
    delegationsOf,
    liveAttempts,
    rootsAtWork,
  };
};
