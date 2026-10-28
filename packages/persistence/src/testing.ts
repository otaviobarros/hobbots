import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { makePgLive } from "./postgres.ts";
import { SqliteLive } from "./sqlite.ts";

/**
 * Test-only database with migrations applied, chosen by `HOBBOTS_TEST_DB`:
 * - `sqlite` (default): a fresh in-memory SQLite database.
 * - `postgres`: a fresh schema in the PostgreSQL database at `HOBBOTS_TEST_DATABASE_URL`,
 *   dropped again when the layer is released.
 *
 * Every build of the layer is isolated, so test runs never see each other's rows.
 */
export const TestDatabase = Layer.unwrap(
  Effect.sync(() => {
    const db = process.env.HOBBOTS_TEST_DB ?? "sqlite";
    if (db === "sqlite") return SqliteLive(":memory:");
    if (db === "postgres") {
      const url = process.env.HOBBOTS_TEST_DATABASE_URL;
      if (!url) throw new Error("HOBBOTS_TEST_DB=postgres needs HOBBOTS_TEST_DATABASE_URL");
      return PgTestLive(Redacted.make(url));
    }
    throw new Error(`Unknown HOBBOTS_TEST_DB "${db}"; use "sqlite" or "postgres"`);
  }),
);

const PgTestLive = (url: Redacted.Redacted) => {
  const schema = `hobbots_test_${randomUUID().replaceAll("-", "")}`;
  // Creates the schema before the client connects and drops it after the client closes.
  const Schema = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.acquireRelease(sql`CREATE SCHEMA ${sql(schema)}`, () =>
        sql`DROP SCHEMA ${sql(schema)} CASCADE`.pipe(Effect.ignore),
      );
    }),
  ).pipe(Layer.provide(PgClient.layer({ url, maxConnections: 1 })));
  return makePgLive({ url, startupParameters: { search_path: schema } }).pipe(Layer.provide(Schema));
};
