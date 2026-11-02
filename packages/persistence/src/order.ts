import type { SqlClient } from "effect/sql";

/** Oldest first, by `created_at` then `id`; text compares byte by byte on both dialects. */
export const oldestFirst = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () => sql.literal(`created_at COLLATE "C", id COLLATE "C"`),
    orElse: () => sql.literal("created_at, id"),
  });

/** Text columns byte by byte on both dialects, then number columns. */
export const byteOrder = (sql: SqlClient.SqlClient, text: ReadonlyArray<string>, numbers: ReadonlyArray<string> = []) =>
  sql.onDialectOrElse({
    pg: () => sql.literal([...text.map((column) => `${column} COLLATE "C"`), ...numbers].join(", ")),
    orElse: () => sql.literal([...text, ...numbers].join(", ")),
  });
