import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

// A cursor projector's row in `projector_cursors` (migration 0100, STD-ARCH-016): the journal
// sequence it has read through, which moves only forward, in the transaction that writes its page.

/** The journal sequence the projector `name` has read through. */
export const projectorCursor = (sql: SqlClient.SqlClient, name: string) =>
  sql<{ readonly sequence: unknown }>`SELECT sequence FROM projector_cursors WHERE name = ${name}`.pipe(
    Effect.map(([row]) => Number(row?.sequence ?? 0)),
  );

/** Moves the projector's cursor to `sequence`; a round that read an older page never moves it back. */
export const moveProjectorCursor = (sql: SqlClient.SqlClient, name: string, sequence: number) =>
  sql`UPDATE projector_cursors SET sequence = ${sequence} WHERE name = ${name} AND sequence < ${sequence}`;
