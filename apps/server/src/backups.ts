import { chmod, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SaveDestinations } from "@hobbots/agents";
import { BackupRefused, type BackupState, type BackupStatus, type BackupStep, type InvalidFolder } from "@hobbots/api";
import { MemoryEngine } from "@hobbots/memory";
import { copyLiveDatabase, finishBackupCopy } from "@hobbots/persistence";
import { Context, DateTime, Duration, Effect, FiberHandle, Layer, Option, Ref, Schema, type Scope } from "effect";
import {
  BACKUP_FORMAT,
  BACKUP_PARTS,
  type BackupManifest,
  backupFolderName,
  copyTree,
  hashFile,
  isInside,
  type ManifestFile,
  MEMORY_PART,
  sizeOf,
  writeManifest,
} from "./backup-files.ts";
import { BackupHolds } from "./backup-holds.ts";
import { defaultSaveFolder } from "./destination.ts";
import { Installation } from "./installation.ts";
import { readMemorySettings } from "./memory-settings.ts";
import { readNetworkSettings } from "./network-settings.ts";

/** Why a backup stopped, in words for Settings. */
class BackupFailed extends Schema.TaggedError<BackupFailed>()("BackupFailed", { reason: Schema.String }) {}

/** How long a backup waits for replies that can write to the default workspace (ADR 026). */
const WORKSPACE_WAIT = Duration.minutes(10);

const failed = (step: string) => (cause: unknown) =>
  new BackupFailed({
    reason: `Hobbots could not ${step}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const attempt = <A>(step: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failed(step) });

export interface WriteBackupOptions {
  readonly dataDir: string;
  /** The `.hobbots-backup` folder to make; it must not exist yet. */
  readonly folder: string;
  readonly version: string;
  readonly installationId: string;
  /** Copies the database to the path it is given. */
  readonly copyDatabase: (destination: string) => Effect.Effect<unknown, unknown>;
  /** Holds cleanup for the whole backup; absent with no hub running. */
  readonly holdCleanup?: Effect.Effect<void, never, Scope.Scope>;
  /** Holds the default workspace until it is copied; absent with no hub running. */
  readonly holdWorkspace?: (waiting: (turns: number) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Writes memory's own backup to the path it is given (ADR 028), and answers whether there was
   * memory to save. Absent with no memory engine, as in tests that do not need one.
   */
  readonly backupMemory?: (target: string) => Effect.Effect<boolean, { readonly reason: string }>;
  readonly progress?: (state: BackupState) => Effect.Effect<void>;
}

/**
 * Makes one backup (ADR 026): the database copied with SQLite's online backup API and scrubbed of
 * every device secret, the default workspace, the Workbench contents, the tool logs, memory as its
 * engine backs it up (ADR 028) and the port, and the manifest written last with each file's size and
 * SHA-256. Owner-only throughout. A failure or
 * an interruption deletes what it wrote. Returns the folder and its size.
 */
export const writeBackup = (options: WriteBackupOptions) =>
  Effect.gen(function* () {
    const { dataDir, folder } = options;
    const progress = options.progress ?? (() => Effect.void);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // Deletes from here on whatever this backup wrote, if it does not finish: the folder is never
    // made without that in place, even when the backup is cancelled as it starts.
    yield* attempt("make the backup folder", () => mkdir(folder, { mode: 0o700 })).pipe(
      Effect.tap(() =>
        Effect.addFinalizer((exit) =>
          exit._tag === "Success" ? Effect.void : Effect.promise(() => rm(folder, { recursive: true, force: true })),
        ),
      ),
      Effect.uninterruptible,
    );
    if (options.holdCleanup) yield* options.holdCleanup;

    const sources = {
      database: join(dataDir, BACKUP_PARTS.database.data),
      workspace: join(dataDir, BACKUP_PARTS.workspace.data),
      activity: join(dataDir, BACKUP_PARTS.activity.data),
      toolLogs: join(dataDir, BACKUP_PARTS.toolLogs.data),
      memory: join(dataDir, "memory"),
    };
    const total = yield* attempt("measure the data folder", async () =>
      [sources.database, sources.workspace, sources.activity, sources.toolLogs, sources.memory]
        .map((path) => sizeOf(path))
        .reduce(async (sum, next) => (await sum) + (await next), Promise.resolve(0)),
    );
    const copied = yield* Ref.make(0);
    const report = (step: BackupStep) =>
      Effect.flatMap(Ref.get(copied), (bytes) =>
        progress({ _tag: "Copying", step, copiedBytes: bytes, totalBytes: Math.max(total, bytes) }),
      );
    const counting = (step: BackupStep) => {
      let last = 0;
      return (n: number) => {
        Effect.runSync(Ref.update(copied, (bytes) => bytes + n));
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          Effect.runFork(report(step));
        }
      };
    };

    const files: Array<ManifestFile> = [];
    const database = join(folder, BACKUP_PARTS.database.backup);
    // The workspace hold stands from before the snapshot until the workspace is copied, so its files
    // match the records in the snapshot.
    yield* Effect.scoped(
      Effect.gen(function* () {
        if (options.holdWorkspace) {
          const since = DateTime.formatIso(yield* DateTime.now);
          yield* options
            .holdWorkspace((turns) => (turns > 0 ? progress({ _tag: "Waiting", turns, since }) : Effect.void))
            .pipe(
              Effect.timeoutOrElse({
                duration: WORKSPACE_WAIT,
                orElse: () =>
                  Effect.fail(
                    new BackupFailed({
                      reason:
                        "A reply was still working in the default workspace after 10 minutes, so the backup stopped. Try again once it ends, or stop it.",
                    }),
                  ),
              }),
            );
        }
        yield* report("database");
        yield* options.copyDatabase(database).pipe(Effect.mapError(failed("copy the database")));
        yield* attempt("protect the database copy", () => chmod(database, 0o600));
        yield* report("workspace");
        files.push(
          ...(yield* attempt("copy the default workspace", () =>
            copyTree(
              sources.workspace,
              join(folder, BACKUP_PARTS.workspace.backup),
              BACKUP_PARTS.workspace.backup,
              counting("workspace"),
            ),
          )),
        );
      }),
    );

    // The copy is scrubbed and checked on its own, never the hub's database.
    const finished = yield* finishBackupCopy(database).pipe(
      Effect.catchTag("BackupCopyDamaged", () =>
        Effect.fail(new BackupFailed({ reason: "The copy of the database failed SQLite's integrity check." })),
      ),
      Effect.mapError((error) =>
        error instanceof BackupFailed ? error : failed("check the copy of the database")(error),
      ),
    );
    files.push({
      path: BACKUP_PARTS.database.backup,
      ...(yield* attempt("read the database copy", () => hashFile(database))),
    });

    yield* report("activity");
    files.push(
      ...(yield* attempt("copy the Workbench contents", () =>
        copyTree(
          sources.activity,
          join(folder, BACKUP_PARTS.activity.backup),
          BACKUP_PARTS.activity.backup,
          counting("activity"),
        ),
      )),
    );
    yield* report("tool-logs");
    files.push(
      ...(yield* attempt("copy the tool logs", () =>
        copyTree(
          sources.toolLogs,
          join(folder, BACKUP_PARTS.toolLogs.backup),
          BACKUP_PARTS.toolLogs.backup,
          counting("tool-logs"),
        ),
      )),
    );

    // Memory as its own engine backs it up while it runs, with no memory bearer in it (ADR 028).
    if (options.backupMemory) {
      yield* report("memory");
      const archive = join(folder, MEMORY_PART);
      yield* attempt("make the memory folder", () => mkdir(join(folder, "memory"), { mode: 0o700 }));
      const saved = yield* options
        .backupMemory(archive)
        .pipe(
          Effect.mapError(
            (refused) => new BackupFailed({ reason: `Hobbots could not back up memory: ${refused.reason}.` }),
          ),
        );
      if (saved) {
        const entry = yield* attempt("read the memory backup", () => hashFile(archive));
        yield* Ref.update(copied, (bytes) => bytes + entry.size);
        files.push({ path: MEMORY_PART, ...entry });
      } else {
        // No memory was ever kept here: the backup holds no memory folder.
        yield* attempt("tidy the memory folder", () => rmdir(join(folder, "memory")));
      }
    }

    // The port only: remote access is always off in a backup.
    yield* report("manifest");
    const { port } = readNetworkSettings(dataDir);
    const network = join(folder, BACKUP_PARTS.network.backup);
    yield* attempt("save the port", async () => {
      await mkdir(join(folder, "settings"), { mode: 0o700 });
      await writeFile(network, `${JSON.stringify(port === undefined ? {} : { port }, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    });
    files.push({ path: "settings/network.json", ...(yield* attempt("read the port", () => hashFile(network))) });

    // The memory model you chose, in Hobbots' own words; it never holds a credential.
    const memorySettings = join(folder, BACKUP_PARTS.memorySettings.backup);
    yield* attempt("save the memory model", () =>
      writeFile(memorySettings, `${JSON.stringify(readMemorySettings(dataDir), null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      }),
    );
    files.push({
      path: "settings/memory-settings.json",
      ...(yield* attempt("read the memory model", () => hashFile(memorySettings))),
    });

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt,
      hobbotsVersion: options.version,
      storage: "sqlite",
      database: "included",
      schemaVersion: finished.schemaVersion,
      installationId: options.installationId,
      counts: finished.counts,
      hobFolders: finished.hobFolders,
      files,
    };
    yield* attempt("write the manifest", () => writeManifest(folder, manifest));
    const size = files.reduce((sum, file) => sum + file.size, 0);
    return { path: folder, size };
  }).pipe(Effect.scoped);

/** Settings › Backup & export › Back up now, on a running hub (ADR 026). */
export class HubBackups extends Context.Service<
  HubBackups,
  {
    readonly status: Effect.Effect<BackupStatus>;
    readonly start: (destination: string) => Effect.Effect<BackupStatus, BackupRefused | InvalidFolder>;
    readonly cancel: Effect.Effect<BackupStatus>;
  }
>()("@hobbots/server/HubBackups") {
  static readonly layer = Layer.effect(
    HubBackups,
    Effect.gen(function* () {
      const identity = yield* Installation;
      const holds = yield* BackupHolds;
      const destinations = yield* SaveDestinations;
      const memory = yield* Effect.serviceOption(MemoryEngine);
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof copyLiveDatabase>>>();
      const state = yield* Ref.make<BackupState>({ _tag: "Idle" });
      const running = yield* FiberHandle.make<void, never>();
      const defaultDestination = defaultSaveFolder();
      const status = Effect.map(Ref.get(state), (current): BackupStatus => ({ state: current, defaultDestination }));
      const busy = (current: BackupState) => current._tag === "Waiting" || current._tag === "Copying";
      const finishedAt = Effect.map(DateTime.now, DateTime.formatIso);

      const start = (typed: string) =>
        Effect.gen(function* () {
          if (busy(yield* Ref.get(state))) return yield* new BackupRefused({ reason: "A backup is already running." });
          const destination = yield* destinations.check(typed);
          if (isInside(destination, identity.dataDir) || isInside(identity.dataDir, destination)) {
            return yield* new BackupRefused({
              reason: "Choose a folder outside the Hobbots data folder, so the backup does not copy itself.",
            });
          }
          const folder = join(destination, backupFolderName(new Date()));
          yield* Ref.set(state, { _tag: "Copying", step: "database", copiedBytes: 0, totalBytes: 0 });
          const run = writeBackup({
            dataDir: identity.dataDir,
            folder,
            version: identity.version,
            installationId: identity.installationId,
            copyDatabase: (target) => copyLiveDatabase(target).pipe(Effect.provideContext(context)),
            holdCleanup: holds.holdCleanup,
            holdWorkspace: holds.holdWorkspace,
            ...(Option.isSome(memory) ? { backupMemory: memory.value.backup } : {}),
            progress: (next) => Ref.set(state, next),
          }).pipe(
            Effect.flatMap(({ path, size }) =>
              Effect.flatMap(finishedAt, (at) => Ref.set(state, { _tag: "Done", path, size, finishedAt: at })),
            ),
            Effect.catch((error) =>
              Effect.flatMap(finishedAt, (at) =>
                Ref.set(state, {
                  _tag: "Failed",
                  reason: error instanceof BackupFailed ? error.reason : `The backup failed: ${String(error)}`,
                  finishedAt: at,
                }),
              ),
            ),
            Effect.onInterrupt(() =>
              Effect.flatMap(finishedAt, (at) =>
                Ref.set(state, { _tag: "Failed", reason: "You cancelled the backup.", finishedAt: at }),
              ),
            ),
          );
          yield* FiberHandle.run(running, run);
          return yield* status;
        });

      const cancel = Effect.gen(function* () {
        yield* FiberHandle.clear(running);
        return yield* status;
      });

      return HubBackups.of({ status, start, cancel });
    }),
  );
}
