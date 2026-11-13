import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/index.ts";
import { runMigrations } from "../src/migrator.ts";
import { TestDatabaseAt } from "../src/testing.ts";

type Record = Parameters<typeof runMigrations>[0];

/** A migration that makes a table of its own, so a test sees whether and when it ran. */
const makes = (table: string): Record[string] =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ${sql(table)} (id INTEGER PRIMARY KEY)`;
  });

const applied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ migrationId: unknown; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [Number(row.migrationId), row.name] as const);
});

/** Puts back the table exactly as Effect's migrator made it before ADR 040, with ids 1 and 2 applied. */
const effectMigratorTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE effect_sql_migrations`;
  yield* sql.onDialectOrElse({
    pg: () => sql`CREATE TABLE effect_sql_migrations (
      migration_id integer primary key,
      created_at timestamp with time zone not null default now(),
      name text not null
    )`,
    orElse: () => sql`CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )`,
  });
  yield* sql`INSERT INTO effect_sql_migrations ${sql.insert([
    { migrationId: 1, name: "first" },
    { migrationId: 2, name: "second" },
  ])}`;
});

describe("migrator", () => {
  // covers DP-003
  it("[TC-DP-040-01] names every migration 0001 to 0114, or by the UTC second it was made", () => {
    const ids = Object.keys(migrations).map((key) => key.split("_")[0] ?? "");
    const numbered = ids.filter((id) => id.length === 4);
    expect(numbered.map(Number)).toEqual(numbered.map((_, index) => index + 1));
    expect(numbered).toHaveLength(114);
    for (const id of ids.filter((id) => id.length !== 4)) {
      const second = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
      expect(second, `${id} is not YYYYMMDDHHMMSS`).not.toBeNull();
      const [, year, month, day, hour, min, sec] = (second ?? []).map(Number);
      const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day, hour, min, sec));
      expect(date.toISOString().slice(0, 19).replace(/\D/g, "")).toBe(id);
      expect(Number(id)).toBeGreaterThanOrEqual(20261113000000);
    }
    expect(ids).toEqual([...ids].sort((a, b) => Number(a) - Number(b)));
  });

  // covers DP-003
  it("[TC-DP-040-02] applies a migration whose id is below one already applied, and only once", async () => {
    const result = await Effect.gen(function* () {
      const first = yield* runMigrations({ "20261114090000_later": makes("later_one") });
      // A pull request opened earlier merges after it: its id is lower, and it still runs.
      const second = yield* runMigrations({
        "20261113120000_earlier": makes("earlier_one"),
        "20261114090000_later": makes("later_one"),
      });
      const third = yield* runMigrations({
        "20261113120000_earlier": makes("earlier_one"),
        "20261114090000_later": makes("later_one"),
      });
      return { first, second, third, applied: yield* applied };
    }).pipe(Effect.provide(TestDatabaseAt({})), Effect.runPromise);
    expect(result.first).toEqual(["20261114090000_later"]);
    expect(result.second).toEqual(["20261113120000_earlier"]);
    expect(result.third).toEqual([]);
    expect(result.applied).toEqual([
      [20261113120000, "earlier"],
      [20261114090000, "later"],
    ]);
  });

  // covers DP-003
  it("[TC-DP-040-03] upgrades a database Effect's migrator made, keeping what it applied", async () => {
    const result = await Effect.gen(function* () {
      yield* effectMigratorTable;
      const ran = yield* runMigrations({
        "0001_first": makes("never_one"),
        "0002_second": makes("never_two"),
        "0003_third": makes("third_one"),
        "20261113231542_second": makes("second_one"),
      });
      const sql = yield* SqlClient.SqlClient;
      const type = yield* sql.onDialectOrElse({
        pg: () =>
          Effect.map(
            sql<{ dataType: string }>`
              SELECT data_type FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'effect_sql_migrations'
                AND column_name = 'migration_id'
            `,
            (rows) => rows[0]?.dataType,
          ),
        orElse: () => Effect.succeed("integer"),
      });
      return { ran, type, applied: yield* applied };
    }).pipe(Effect.provide(TestDatabaseAt({})), Effect.runPromise);
    expect(result.ran).toEqual(["0003_third", "20261113231542_second"]);
    expect(result.applied).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"],
      [20261113231542, "second"],
    ]);
    // On PostgreSQL the id column is widened to hold a second's id.
    expect(["bigint", "integer"]).toContain(result.type);
    if (process.env.HOBBOTS_TEST_DB === "postgres") expect(result.type).toBe("bigint");
  });

  // covers DP-003
  it("[TC-DP-040-04] refuses two migrations with one id, as two branches made in one second would have, and applies none of a failed run", async () => {
    const result = await Effect.gen(function* () {
      const duplicate = yield* runMigrations({ "0001_one": makes("a_one"), "1_two": makes("a_two") }).pipe(Effect.flip);
      const failing = yield* runMigrations({
        "20261113120000_fine": makes("fine_one"),
        "20261113130000_broken": Effect.fail("broken"),
      }).pipe(Effect.flip);
      return { duplicate: duplicate.message, failing: failing.message, applied: yield* applied };
    }).pipe(Effect.provide(TestDatabaseAt({})), Effect.runPromise);
    expect(result.duplicate).toBe('Migrations "0001_one" and "1_two" share the id 1');
    expect(result.failing).toBe('Migration "20261113130000_broken" failed');
    expect(result.applied).toEqual([]);
  });
});
