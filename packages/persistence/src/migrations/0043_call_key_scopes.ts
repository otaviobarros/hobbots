import { stableJson } from "@hobbots/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A tool call's key is unique within the work it belongs to, not among all of its hob's calls (#660),
// so a key a hob chose for one Task, such as `cp-tests-passing`, is free again for the next. Each
// table of keyed calls gains `scope`: `task:<Task id>` for a turn on a Task, or `reply:<message id>`
// for a chat turn that started on none, which its retries and Continue share. Its key is unique per
// hob, scope and key.
//
// SQLite cannot change a primary key, so each table is rebuilt, on both databases alike: the new
// table is made beside the old one, the rows are copied with a scope, and the old table is dropped
// before the new one takes its name. A stored Task tool call keeps the turn its input names, as
// `task:` or `reply:`, and its input loses that turn, since calls are now compared without it. A Charm
// call keeps its reply. A chat turn's retry also looks in its reply's scope, so Continue still finds
// them. A refusal's input names no turn, and a row that names nothing keeps an empty scope, which no
// new call has. Every stored row stays readable and no two collide. No table
// refers to these, and the constraints are named so they never meet the old tables' own.

type Stored = Record<string, unknown>;

/**
 * A stored Task tool call's scope, from the turn its input names, as `callScope` in `@hobbots/agents`
 * writes it, and its input without that turn, as calls are compared now: the scope names the turn.
 */
const scoped = (row: Stored): Stored => {
  const { turn_reply: reply, turn_task: task, ...input } = JSON.parse(String(row.input)) as Record<string, unknown>;
  const scope = typeof reply === "string" ? `reply:${reply}` : typeof task === "string" ? `task:${task}` : "";
  return { ...row, scope, input: stableJson(input) };
};

/** Swaps `${table}_next`, which the rows were copied into, in for `table`. */
const swap = (sql: SqlClient.SqlClient, table: string) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`DROP TABLE ${table}`);
    yield* sql.unsafe(`ALTER TABLE ${table}_next RENAME TO ${table}`);
  });

export default Effect.gen(function* () {
  // Rows are read and written by their column names, as they are stored.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();

  yield* sql`
    CREATE TABLE task_tool_calls_next (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      scope TEXT NOT NULL,
      call_key TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CONSTRAINT task_tool_calls_scoped_key PRIMARY KEY (agent_id, scope, call_key)
    )
  `;
  const calls = (yield* sql`SELECT * FROM task_tool_calls`).map(scoped);
  for (let start = 0; start < calls.length; start += 100) {
    const [first, ...rest] = calls.slice(start, start + 100);
    if (first !== undefined) yield* sql`INSERT INTO task_tool_calls_next ${sql.insert([first, ...rest])}`;
  }
  yield* swap(sql, "task_tool_calls");

  yield* sql`DROP INDEX task_tool_refusals_task`;
  yield* sql`
    CREATE TABLE task_tool_refusals_next (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      scope TEXT NOT NULL,
      call_key TEXT,
      task_id TEXT,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      reason TEXT NOT NULL,
      message TEXT NOT NULL,
      tries INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      refused_at TEXT NOT NULL,
      CONSTRAINT task_tool_refusals_scoped_key UNIQUE (agent_id, scope, call_key)
    )
  `;
  const refusalColumns = `id, agent_id, call_key, task_id, tool, input, reason, message, tries, created_at, refused_at`;
  yield* sql.unsafe(`INSERT INTO task_tool_refusals_next (scope, ${refusalColumns})
    SELECT '', ${refusalColumns} FROM task_tool_refusals`);
  yield* swap(sql, "task_tool_refusals");
  yield* sql`CREATE INDEX task_tool_refusals_task ON task_tool_refusals (task_id)`;

  yield* sql`DROP INDEX charm_calls_site`;
  yield* sql`DROP INDEX charm_calls_step`;
  yield* sql`
    CREATE TABLE charm_calls_next (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      scope TEXT NOT NULL,
      call_key TEXT NOT NULL,
      attempt TEXT NOT NULL,
      tool TEXT NOT NULL,
      input TEXT NOT NULL,
      site TEXT NOT NULL,
      plan TEXT NOT NULL,
      state TEXT NOT NULL,
      result TEXT,
      thread_id TEXT,
      message_id TEXT,
      step_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT charm_calls_scoped_key PRIMARY KEY (agent_id, scope, call_key)
    )
  `;
  const charmColumns = `agent_id, call_key, attempt, tool, input, site, plan, state, result, thread_id, message_id,
    step_id, created_at, updated_at`;
  yield* sql.unsafe(`INSERT INTO charm_calls_next (scope, ${charmColumns})
    SELECT CASE WHEN message_id IS NULL THEN '' ELSE 'reply:' || message_id END, ${charmColumns} FROM charm_calls`);
  yield* swap(sql, "charm_calls");
  yield* sql`CREATE INDEX charm_calls_site ON charm_calls (tool, site, state)`;
  yield* sql`CREATE INDEX charm_calls_step ON charm_calls (thread_id, message_id, step_id)`;
});
