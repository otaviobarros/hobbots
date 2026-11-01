import {
  AgentId,
  ArtifactRef,
  Attempt,
  Checkpoint,
  Delegation,
  descendantsOf,
  HandOff,
  MemberWork,
  Milestone,
  Quest,
  Question,
  Task,
  type TaskId,
  TaskTree,
  TaskWait,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { oldestFirst } from "./order.ts";

// The stored shape of each record (migrations 0024 and 0025): JSON text columns, numbers that PostgreSQL
// reads as bigints, and a Task's result split into two columns.
type Row = Record<string, unknown>;

const json = (value: unknown) => (value == null ? null : JSON.parse(String(value)));
const int = (value: unknown) => (value == null ? null : Number(value));

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
    revision: int(row.revision),
  }),
  artifact: (row: Row) => row,
  handOff: (row: Row) => row,
  wait: (row: Row) => ({ taskId: row.taskId, on: json(row.waitsOn), mode: row.mode, createdAt: row.createdAt }),
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
  wait: Schema.decodeUnknownEffect(Schema.Array(TaskWait)),
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
  readonly wait: TaskWait;
}

/** Decodes stored rows as records of `kind`. A row that does not decode is a defect: the hub wrote it. */
const decodeRows =
  <K extends keyof Records>(kind: K) =>
  (rows: ReadonlyArray<Row>): Effect.Effect<ReadonlyArray<Records[K]>> =>
    (decoders[kind](rows.map(fromRow[kind])) as Effect.Effect<ReadonlyArray<Records[K]>, Schema.SchemaError>).pipe(
      Effect.orDie,
    );

// Text sorts byte by byte on both dialects, as `oldestFirst` does; numbers follow.
const orderBy = (sql: SqlClient.SqlClient, text: ReadonlyArray<string>, numbers: ReadonlyArray<string> = []) =>
  sql.onDialectOrElse({
    pg: () => sql.literal([...text.map((column) => `${column} COLLATE "C"`), ...numbers].join(", ")),
    orElse: () => sql.literal([...text, ...numbers].join(", ")),
  });

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
        waits: yield* sql<Row>`SELECT * FROM task_waits WHERE ${inTree("task_id")}
          ORDER BY ${orderBy(sql, ["created_at", "task_id"])}`.pipe(Effect.flatMap(decodeRows("wait"))),
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
      const threadIds = [...new Set(quests.flatMap((each) => (each.threadId === null ? [] : [each.threadId])))];
      const owners =
        threadIds.length === 0
          ? []
          : yield* sql<{ readonly id: string; readonly agentId: string }>`SELECT id, agent_id FROM threads
              WHERE ${sql.in("id", threadIds)}`;
      const ownerOf = new Map(owners.map((each) => [each.id, AgentId.make(each.agentId)]));
      return tasks.flatMap((task) => {
        const delegation = byTask.get(task.id);
        const quest = delegation && active.get(delegation.questId);
        if (!delegation || !quest) return [];
        const threadAgentId = quest.threadId === null ? null : (ownerOf.get(quest.threadId) ?? null);
        return [new MemberWork({ task, delegation, quest, threadAgentId })];
      });
    });

  return { task, treeOf, questsOn, quest, attempt, question, artifact, readTree, threadTrees, memberWork };
};
