import { Effect, Option } from "effect";
import { SqlError } from "effect/sql";

/** `effect`, with a database error as a defect: a record the hub cannot read or write is a broken hub. */
export const sqlOrDie = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is SqlError.SqlError => SqlError.isSqlError(error),
      (error) => Effect.die(error),
    ),
  );

/** The first row a query answers, read with `fromRow`, or None when it answers none. */
export const firstRow = <Row, A, R>(
  query: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError, R>,
  fromRow: (row: Row) => Effect.Effect<A>,
) =>
  sqlOrDie(
    Effect.flatMap(query, ([row]) => (row === undefined ? Effect.succeedNone : Effect.map(fromRow(row), Option.some))),
  );
