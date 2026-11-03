import { randomUUID } from "node:crypto";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { WINDOW_DEVICE_ID } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Schema, String as Str } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { migrations } from "./migrations/index.ts";

/**
 * The schema version a Hobbots knows: the highest migration in `record`, such as 38. A backup from a
 * higher one is refused (ADR 026).
 */
export const knownSchemaVersion = (record: Record<string, unknown> = migrations): number =>
  Math.max(0, ...Object.keys(record).map((key) => Number.parseInt(key, 10)));

/** The highest migration the database has applied, or 0 for a database that has none. */
export const schemaVersion: Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly version: unknown;
  }>`SELECT MAX(migration_id) AS version FROM effect_sql_migrations`;
  return Number(rows[0]?.version ?? 0);
});

/** What a backup's manifest counts, so a restore can say what comes back before it changes anything. */
export interface BackupCounts {
  readonly hobs: number;
  readonly threads: number;
  readonly quests: number;
  readonly tasks: number;
}

/**
 * Which tables and columns a backup's copy of the database has. A copy made before a migration on
 * update can be from any older schema, so a backup reads only what that schema holds.
 */
interface CopySchema {
  readonly has: (table: string, column?: string) => boolean;
}

/** Every schema since migration 0038 has every table and column a backup reads. */
const CURRENT: CopySchema = { has: () => true };

/** The tables and columns of the SQLite database open on the client. */
const sqliteSchema: Effect.Effect<CopySchema, SqlError.SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly tableName: string; readonly columnName: string }>`
    SELECT m.name AS table_name, c.name AS column_name
    FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table'
  `;
  const tables = new Set(rows.map((row) => row.tableName));
  const columns = new Set(rows.map((row) => `${row.tableName}.${row.columnName}`));
  return { has: (table, column) => (column === undefined ? tables.has(table) : columns.has(`${table}.${column}`)) };
});

const backupCounts = (schema: CopySchema): Effect.Effect<BackupCounts, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const count = (table: string) =>
      schema.has(table)
        ? sql<{ readonly n: unknown }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(
            Effect.map((rows) => Number(rows[0]?.n ?? 0)),
          )
        : Effect.succeed(0);
    return {
      hobs: yield* count("agents"),
      threads: yield* count("threads"),
      quests: yield* count("quests"),
      tasks: yield* count("tasks"),
    };
  });

/** A hob's own folders, as a backup's manifest lists them, so a restore can say which are missing. */
export interface HobFolders {
  readonly agentId: string;
  readonly name: string;
  readonly folders: ReadonlyArray<string>;
}

const FolderList = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeFolders = Schema.decodeUnknownSync(FolderList);

/** Each hob's own folders, and the folders every hob shares under the name `Shared folders`. */
const hobFolders = (
  schema: CopySchema,
): Effect.Effect<ReadonlyArray<HobFolders>, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const hobs = schema.has("agents", "own_folders")
      ? yield* sql<{
          readonly id: string;
          readonly name: string;
          readonly ownFolders: unknown;
        }>`SELECT id, name, own_folders FROM agents ORDER BY id`
      : [];
    const shared = schema.has("installation_setup", "approved_folders")
      ? yield* sql<{ readonly approvedFolders: unknown }>`SELECT approved_folders FROM installation_setup`
      : [];
    const sharedFolders = shared[0] === undefined ? [] : decodeFolders(String(shared[0].approvedFolders));
    return [
      ...(sharedFolders.length === 0 ? [] : [{ agentId: "", name: "Shared folders", folders: sharedFolders }]),
      ...hobs
        .map((hob) => ({ agentId: hob.id, name: hob.name, folders: decodeFolders(String(hob.ownFolders)) }))
        .filter((hob) => hob.folders.length > 0),
    ];
  });

/**
 * Takes every device secret out of a backup's copy of the database (ADR 026): blanks each device's
 * token hash and deletes every pairing request with its secret hash. Runs on the copy, never on the
 * hub's own database.
 */
const scrub = (schema: CopySchema): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Devices and pairing arrived with migration 0031: an older copy holds no device secret.
    if (schema.has("devices", "token_hash")) yield* sql`UPDATE devices SET token_hash = NULL`;
    if (schema.has("pairing_requests")) yield* sql`DELETE FROM pairing_requests`;
  });

export const scrubBackupCopy = scrub(CURRENT);

/** Whether SQLite finds the database file sound, as `PRAGMA integrity_check` reports it. */
const integrityOk: Effect.Effect<boolean, SqlError.SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly integrityCheck: unknown }>`PRAGMA integrity_check`;
  return rows.length === 1 && rows[0]?.integrityCheck === "ok";
});

/**
 * Copies the hub's database to `destination` with SQLite's online backup API, on the hub's own
 * connection: writes through it wait for the copy, which is a consistent snapshot of the moment it
 * finishes (ADR 026).
 */
export const copyLiveDatabase = (destination: string) =>
  Effect.flatMap(SqliteClient.SqliteClient, (client) => client.backup(destination));

/** Runs `use` on the SQLite file at `filename`, opened on its own and closed after, with no migrations. */
export const onDatabaseFile = <A, E>(
  filename: string,
  use: Effect.Effect<A, E, SqlClient.SqlClient | SqliteClient.SqliteClient>,
) =>
  Effect.provide(
    use,
    SqliteClient.layer({
      filename,
      disableWAL: true,
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel,
    }),
  );

/** What a backup's copy of the database says, once it is scrubbed, for the manifest. */
export interface FinishedCopy {
  readonly schemaVersion: number;
  readonly counts: BackupCounts;
  readonly hobFolders: ReadonlyArray<HobFolders>;
}

/** Raised when a backup's copy of the database fails SQLite's integrity check. */
export class BackupCopyDamaged extends Schema.TaggedError<BackupCopyDamaged>()("BackupCopyDamaged", {}) {}

/**
 * Finishes a backup's copy of the database at `filename` (ADR 026): takes every device secret out,
 * rewrites the file so no deleted row stays behind in its free pages, leaves it as one file without
 * a write-ahead log, and checks it with `PRAGMA integrity_check`.
 */
export const finishBackupCopy = (filename: string) =>
  onDatabaseFile(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schema = yield* sqliteSchema;
      yield* scrub(schema);
      yield* sql`PRAGMA journal_mode = DELETE`;
      yield* sql`VACUUM`;
      if (!(yield* integrityOk)) return yield* new BackupCopyDamaged();
      return {
        schemaVersion: yield* schemaVersion,
        counts: yield* backupCounts(schema),
        hobFolders: yield* hobFolders(schema),
      } satisfies FinishedCopy;
    }),
  );

/** One restore this database came back from (migration 0038). */
export class RestoreRecord extends Schema.Class<RestoreRecord>("RestoreRecord")({
  id: Schema.String,
  restoredAt: Schema.String,
  backupMadeAt: Schema.String,
  backupVersion: Schema.String,
  /** The data folder set aside beside the restored one, until you delete it. */
  setAside: Schema.NullOr(Schema.String),
  /** The hob folders the backup named that this computer did not have when it was restored. */
  missingFolders: Schema.Array(Schema.String),
  /** When you resumed work; null while work is held. */
  resumedAt: Schema.NullOr(Schema.String),
}) {}

const decodeRestore = Schema.decodeUnknownSync(RestoreRecord);
const restoreOf = (row: Record<string, unknown>) =>
  decodeRestore({ ...row, missingFolders: decodeFolders(String(row.missingFolders)) });

/**
 * The rules of a hub's first start after a restore (ADR 026), in one transaction, before it serves
 * anything: a new journal epoch, every device but the hub's own window revoked by the restore, every
 * token hash blanked and every pairing request deleted, and the restore recorded, which holds work
 * until you resume it. Applying the same restore again changes nothing.
 */
export const applyRestoreRules = (
  restore: Omit<RestoreRecord, "resumedAt">,
): Effect.Effect<boolean, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(applyOnce(sql, restore));
  });

const applyOnce = (sql: SqlClient.SqlClient, restore: Omit<RestoreRecord, "resumedAt">) =>
  Effect.gen(function* () {
    const known = yield* sql`SELECT id FROM restores WHERE id = ${restore.id}`;
    if (known.length > 0) return false;
    yield* sql`UPDATE event_journal_head SET epoch = ${randomUUID()}`;
    yield* sql`UPDATE devices SET revoked_at = ${restore.restoredAt}, revoked_reason = 'restore'
      WHERE revoked_at IS NULL AND id <> ${WINDOW_DEVICE_ID}`;
    yield* sql`UPDATE devices SET token_hash = NULL`;
    yield* sql`DELETE FROM pairing_requests`;
    yield* sql`INSERT INTO restores ${sql.insert({
      id: restore.id,
      restored_at: restore.restoredAt,
      backup_made_at: restore.backupMadeAt,
      backup_version: restore.backupVersion,
      set_aside: restore.setAside,
      missing_folders: JSON.stringify(restore.missingFolders),
      resumed_at: null,
    })}`;
    return true;
  });

/** The restores this database came back from: the latest, resuming held work, and forgetting the folder set aside. */
export class RestoreRepository extends Context.Service<
  RestoreRepository,
  {
    /** The latest restore, or none for a hub that was never restored. */
    readonly latest: Effect.Effect<Option.Option<RestoreRecord>>;
    /** Records that you resumed work after the latest restore; returns it as it now stands. */
    readonly resume: (at: string) => Effect.Effect<Option.Option<RestoreRecord>>;
    /** Forgets the folder set aside by the latest restore, once it is deleted. */
    readonly clearSetAside: Effect.Effect<void>;
  }
>()("@hobbots/persistence/RestoreRepository") {
  static readonly layer = Layer.effect(
    RestoreRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const latest = sql<
        Record<string, unknown>
      >`SELECT * FROM restores ORDER BY restored_at DESC, id DESC LIMIT 1`.pipe(
        Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), restoreOf)),
        Effect.orDie,
      );
      return RestoreRepository.of({
        latest,
        resume: (at) =>
          Effect.gen(function* () {
            const current = yield* latest;
            if (Option.isNone(current) || current.value.resumedAt !== null) return current;
            yield* sql`UPDATE restores SET resumed_at = ${at} WHERE id = ${current.value.id}`.pipe(Effect.orDie);
            return yield* latest;
          }),
        clearSetAside: Effect.gen(function* () {
          const current = yield* latest;
          if (Option.isNone(current)) return;
          yield* sql`UPDATE restores SET set_aside = NULL WHERE id = ${current.value.id}`.pipe(Effect.orDie);
        }),
      });
    }),
  );
}
