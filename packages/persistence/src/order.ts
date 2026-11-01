import type { SqlClient } from "effect/sql";

/** Oldest first, by `created_at` then `id`; text compares byte by byte on both dialects. */
export const oldestFirst = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () => sql.literal(`created_at COLLATE "C", id COLLATE "C"`),
    orElse: () => sql.literal("created_at, id"),
  });
