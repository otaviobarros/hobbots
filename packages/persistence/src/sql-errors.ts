import { Effect } from "effect";
import { SqlError } from "effect/sql";

/** `effect`, with a database error as a defect: a record the hub cannot read or write is a broken hub. */
export const sqlOrDie = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is SqlError.SqlError => SqlError.isSqlError(error),
      (error) => Effect.die(error),
    ),
  );
