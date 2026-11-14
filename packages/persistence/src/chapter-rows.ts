import { Chapter, type ChapterId } from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every number and revision fits a number.
const decodeChapters = Schema.decodeUnknownSync(Schema.Array(Chapter));

/** Rows of `chapters` as chapters; a row that does not decode is a defect, since the hub wrote it. */
export const chapterRows = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  decodeChapters(rows.map((row) => ({ ...row, number: Number(row.number), revision: Number(row.revision) })));

/**
 * The highest revision of the chapter's messages, or 0 with none: what a hub judgment of the chapter
 * read, so it lands only while no message of it changed since (#1557).
 */
export const messagesRevisionOf = (sql: SqlClient.SqlClient, chapterId: ChapterId) =>
  sql<{ readonly revision: unknown }>`SELECT MAX(revision) AS revision FROM messages
    WHERE chapter_id = ${chapterId}`.pipe(Effect.map(([row]) => Number(row?.revision ?? 0)));
