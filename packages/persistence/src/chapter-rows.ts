import { Chapter } from "@hobbots/domain";
import { Schema } from "effect";

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every number and revision fits a number.
const decodeChapters = Schema.decodeUnknownSync(Schema.Array(Chapter));

/** Rows of `chapters` as chapters; a row that does not decode is a defect, since the hub wrote it. */
export const chapterRows = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  decodeChapters(rows.map((row) => ({ ...row, number: Number(row.number), revision: Number(row.revision) })));
