import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What hobs searched and read on the web, and the limits on it (ADR 036, Usage and limits). One row per
// search a runtime reported and per page `web_fetch` read, each with its hob, chat, reply, Task, Attempt
// and turn; Settings › Web in one row; each hob's own limits; and the sessions whose next turn starts
// with search off. Nothing was recorded before, so the tables start empty and the settings at their
// defaults.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE web_searches (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      thread_id TEXT,
      message_id TEXT,
      task_id TEXT,
      attempt_id TEXT,
      turn TEXT,
      runtime TEXT NOT NULL,
      query TEXT NOT NULL,
      result_count INTEGER,
      results TEXT,
      billing TEXT,
      searched_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX web_searches_by_hob ON web_searches (agent_id, searched_at)`;
  yield* sql`CREATE INDEX web_searches_by_thread ON web_searches (thread_id)`;
  yield* sql`CREATE INDEX web_searches_by_task ON web_searches (task_id)`;
  yield* sql`
    CREATE TABLE web_fetches (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      thread_id TEXT,
      message_id TEXT,
      task_id TEXT,
      attempt_id TEXT,
      turn TEXT,
      url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      status INTEGER NOT NULL,
      bytes BIGINT NOT NULL,
      parts INTEGER NOT NULL,
      part INTEGER NOT NULL,
      tokens BIGINT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX web_fetches_by_hob ON web_fetches (agent_id, fetched_at)`;
  yield* sql`CREATE INDEX web_fetches_by_thread ON web_fetches (thread_id)`;
  yield* sql`CREATE INDEX web_fetches_by_task ON web_fetches (task_id)`;
  yield* sql`
    CREATE TABLE web_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      searches_per_turn INTEGER NOT NULL,
      pages_per_turn INTEGER NOT NULL,
      searches_per_day INTEGER NOT NULL,
      blocked_sites TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE agent_web_limits (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      searches_per_turn INTEGER,
      pages_per_turn INTEGER,
      searches_per_day INTEGER,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE web_search_holds (
      work TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      held_at TEXT NOT NULL
    )
  `;
});
