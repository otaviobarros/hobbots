import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadOrCreateMemoryKeys, memoryFolder, memoryKeysFile, packStoppedMemory } from "@hobbots/memory";
import { copyLiveDatabase, hasPendingMigrations, onDatabaseFile, schemaVersion } from "@hobbots/persistence";
import { Effect } from "effect";
import { backupFolderName } from "./backup-files.ts";
import { writeBackup } from "./backups.ts";
import { readInstallationId } from "./installation.ts";

/** Where a hub keeps the backup it made before its last migration (ADR 026), out of every hob's reach. */
export const migrationBackupsFolder = (dataDir: string) => join(dataDir, "backups");

/**
 * Before the migrator applies a new migration on an update, makes the same backup as Back up now into
 * `backups/` in the data folder and keeps only the latest one (ADR 026). Runs before the hub starts,
 * so nothing else uses the database, and memory's engine is not running: its files are packed as they
 * are (ADR 028). A new data folder, or one already up to date, makes none.
 */
export const backupBeforeMigrations = (dataDir: string, version: string) =>
  Effect.gen(function* () {
    const database = join(dataDir, "hobbots.sqlite");
    if (!existsSync(database)) return null;
    const applied = yield* onDatabaseFile(database, schemaVersion).pipe(Effect.orElseSucceed(() => 0));
    if (applied === 0) return null;
    const pending = yield* onDatabaseFile(database, hasPendingMigrations()).pipe(Effect.orElseSucceed(() => false));
    if (!pending) return null;
    const folder = migrationBackupsFolder(dataDir);
    yield* Effect.promise(() => mkdir(folder, { recursive: true, mode: 0o700 }));
    const name = backupFolderName(new Date());
    // One made the same second is replaced: only the latest is kept either way.
    yield* Effect.promise(() => rm(join(folder, name), { recursive: true, force: true }));
    const made = yield* writeBackup({
      dataDir,
      folder: join(folder, name),
      version,
      installationId: readInstallationId(dataDir) ?? "",
      copyDatabase: (target) => onDatabaseFile(database, copyLiveDatabase(target)),
      // With no keys yet, no bearer can be in memory either.
      backupMemory: (target) =>
        Effect.suspend(() =>
          packStoppedMemory(
            memoryFolder(dataDir),
            target,
            existsSync(memoryKeysFile(dataDir)) ? loadOrCreateMemoryKeys(dataDir) : undefined,
          ),
        ),
    });
    // Only the latest is kept.
    for (const other of yield* Effect.promise(() => readdir(folder))) {
      if (other !== name && other.endsWith(".hobbots-backup")) {
        yield* Effect.promise(() => rm(join(folder, other), { recursive: true, force: true }));
      }
    }
    yield* Effect.log(`Backed up the data folder before migrating it from schema ${applied}: ${made.path}`);
    return made.path;
  });
