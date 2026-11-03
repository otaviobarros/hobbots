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
// before the new one takes its name. A stored call keeps the turn its input or reply names, as
// `task:` or `reply:`; a row that names neither, such as a refusal whose input was cut, keeps an empty
// scope, which no new call has. Every stored row stays readable and no two collide. No table refers to
// these, and the constraints are named so they never meet the old tables' own.

type Stored = Record<string, unknown>;

/** The scope a stored Task tool call's input names, or an empty one. */
const scopeOfInput = (input: unknown): string => {
  if (typeof input !== "string") return "";
  try {
    const turn = JSON.parse(input) as { readonly turn_reply?: unknown; readonly turn_task?: unknown };
    if (typeof turn.turn_reply === "string") return `reply:${turn.turn_reply}`;
    if (typeof turn.turn_task === "string") return `task:${turn.turn_task}`;
  } catch {
    // A refusal's input is cut when long, so it may not parse.
  }
  return "";
};

/** Copies `table`'s rows into `${table}_next`, each with its scope. */
const copy = (sql: SqlClient.SqlClient, table: string, scopeOf: (row: Stored) => string) =>
  Effect.gen(function* () {
    const next = sql(`${table}_next`);
    for (const row of yield* sql.unsafe<Stored>(`SELECT * FROM ${table}`)) {
      yield* sql`INSERT INTO ${next} ${sql.insert({ ...row, scope: scopeOf(row) })}`;
    }
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
  yield* copy(sql, "task_tool_calls", (row) => scopeOfInput(row.input));

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
  yield* copy(sql, "task_tool_refusals", (row) => scopeOfInput(row.input));
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
  yield* copy(sql, "charm_calls", (row) => (typeof row.message_id === "string" ? `reply:${row.message_id}` : ""));
  yield* sql`CREATE INDEX charm_calls_site ON charm_calls (tool, site, state)`;
  yield* sql`CREATE INDEX charm_calls_step ON charm_calls (thread_id, message_id, step_id)`;
});
