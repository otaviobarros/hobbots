import { Data, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/**
 * The table that records each applied migration. Effect's migrator made it, so every database from
 * before ADR 040 already has it, with one row for each of 0001 to 0114.
 */
const TABLE = "effect_sql_migrations";

/** A migration key is `<id>_<name>`: a whole number, then the file's name. */
const KEY = /^(\d+)_(\w+)$/;

class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface Pending {
  readonly key: string;
  readonly id: number;
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, SqlClient.SqlClient>;
}

/** Each migration of the record as an id and a name, sorted by id; fails on a bad or repeated id. */
const migrationIds = (record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const seen = new Map<number, string>();
    for (const key of Object.keys(record)) {
      const match = KEY.exec(key);
      if (match === null) return yield* new MigrationError({ message: `Migration "${key}" is not named <id>_<name>` });
      const id = Number(match[1]);
      const other = seen.get(id);
      if (other !== undefined) {
        return yield* new MigrationError({ message: `Migrations "${other}" and "${key}" share the id ${id}` });
      }
      seen.set(id, key);
    }
    return [...seen].sort(([a], [b]) => a - b);
  });

/**
 * Makes the table on a new database. On PostgreSQL, Effect's migrator made `migration_id` an
 * `integer`, too small for ids such as 20261113231542, so an older table is widened to `bigint` once.
 * SQLite's `INTEGER` already holds 64 bits.
 */
const ensureTable = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
          migration_id bigint PRIMARY KEY,
          created_at timestamp with time zone NOT NULL DEFAULT now(),
          name text NOT NULL
        )`.withoutTransform;
        const columns = yield* sql<{ readonly data_type: string }>`
          SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ${TABLE} AND column_name = 'migration_id'
        `.withoutTransform;
        if (columns[0]?.data_type === "integer") {
          yield* sql`ALTER TABLE ${sql(TABLE)} ALTER COLUMN migration_id TYPE bigint`.withoutTransform;
        }
      }),
    orElse: () =>
      sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`.withoutTransform,
  });

/** The ids this database has applied. */
export const appliedMigrationIds: Effect.Effect<
  ReadonlySet<number>,
  SqlError.SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: unknown }>`SELECT migration_id FROM ${sql(TABLE)}`.withoutTransform;
  return new Set(rows.map((row) => Number(row.migration_id)));
});

/**
 * Applies every migration of `record` this database has not applied, in id order, in one
 * transaction, and records each one. Unlike Effect's migrator, which runs only ids above the highest
 * applied one, an id below it still runs: a pull request that adds a migration can merge after one
 * opened later, and every database still gets both (ADR 040). On PostgreSQL the table is locked first,
 * so two hubs starting at once apply each migration once. Returns the keys it applied.
 */
export const runMigrations = (record: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* migrationIds(record);
    yield* ensureTable(sql);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.onDialectOrElse({
          pg: () => sql`LOCK TABLE ${sql(TABLE)} IN ACCESS EXCLUSIVE MODE`.withoutTransform,
          orElse: () => Effect.void,
        });
        const applied = yield* appliedMigrationIds;
        const pending: Array<Pending> = ids
          .filter(([id]) => !applied.has(id))
          .map(([id, key]) => ({ key, id, name: key.slice(key.indexOf("_") + 1), run: record[key] as Pending["run"] }));
        for (const { key, id, name, run } of pending) {
          yield* run.pipe(
            Effect.mapError((cause) => new MigrationError({ message: `Migration "${key}" failed`, cause })),
            Effect.withSpan(`Migrator ${key}`),
          );
          yield* sql`INSERT INTO ${sql(TABLE)} ${sql.insert({ migration_id: id, name })}`.withoutTransform;
        }
        return pending.map(({ key }) => key);
      }),
    );
  });

/** A layer that applies `record`'s pending migrations when it is built. */
export const MigratorLive = (record: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>) =>
  Layer.effectDiscard(runMigrations(record));
