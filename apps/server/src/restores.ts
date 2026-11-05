import { readFile, rm, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ChatService, HobbotsRepository, WorkHold } from "@hobbots/agents";
import { RestoreRefused, type RestoreStatus, RestoreSummary } from "@hobbots/api";
import { applyRestoreRules, knownSchemaVersion, type RestoreRecord, RestoreRepository } from "@hobbots/persistence";
import { Context, DateTime, Effect, Layer, Option, Ref } from "effect";
import {
  type BackupManifest,
  decodeMarker,
  missingFolders,
  NotRestorable,
  readBackup,
  restoreInto,
  restoreMarkerFile,
  sizeOf,
} from "./backup-files.ts";
import { Installation } from "./installation.ts";

/**
 * Stops this hub and starts it again on restored data (ADR 026), or with no data after Start over
 * (#948): the server's main loop provides it. Absent, as in tests, the hub cannot restore or reset
 * while it runs.
 */
export class HubRestart extends Context.Service<
  HubRestart,
  { readonly restore: (backup: string) => Effect.Effect<void>; readonly reset: Effect.Effect<void> }
>()("@hobbots/server/HubRestart") {}

/** Why the restore asked for before this start did not happen; the hub kept its data. */
export class RestoreOutcome extends Context.Service<RestoreOutcome, { readonly failed: string | null }>()(
  "@hobbots/server/RestoreOutcome",
) {}

const reasonOf = (error: unknown) =>
  error instanceof NotRestorable ? error.message : `Hobbots could not read the backup: ${String(error)}`;

/** Reads and checks a backup, refused in words when it cannot be restored. */
export const checkBackup = (path: string) =>
  Effect.tryPromise({
    try: () => readBackup(path, knownSchemaVersion()),
    catch: (error) => new RestoreRefused({ reason: reasonOf(error) }),
  });

/** What a checked backup holds, for the summary shown before a restore. */
export const summaryOf = (path: string, manifest: BackupManifest) =>
  Effect.promise(async () =>
    RestoreSummary.make({
      path,
      createdAt: manifest.createdAt,
      hobbotsVersion: manifest.hobbotsVersion,
      schemaVersion: manifest.schemaVersion,
      ...manifest.counts,
      missingFolders: await missingFolders(manifest),
    }),
  );

/**
 * Restores the backup at `path` into `dataDir`, with no hub running there: checks it again, then
 * moves the hub's files aside and copies the backup in. Fails with the reason, changing nothing.
 */
export const performRestore = (dataDir: string, path: string) =>
  Effect.gen(function* () {
    const manifest = yield* checkBackup(path);
    return yield* Effect.tryPromise({
      try: () => restoreInto(dataDir, path, manifest, new Date()),
      catch: (error) =>
        new RestoreRefused({ reason: `Hobbots could not restore the backup, and kept its data: ${String(error)}` }),
    });
  });

/**
 * The rules of the first start after a restore (ADR 026), applied from the marker the restore left,
 * before anything else is served: then the marker is deleted. Applying it twice changes nothing.
 */
export const RestoreRulesLive = (dataDir: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const file = restoreMarkerFile(dataDir);
      const text = yield* Effect.promise(() => readFile(file, "utf8").catch(() => null));
      if (text === null) return;
      const marker = decodeMarker(text);
      yield* applyRestoreRules(marker);
      yield* Effect.promise(() => unlink(file));
      yield* Effect.log(`Restored a backup made ${marker.backupMadeAt}; work is held until you resume it`);
    }),
  );

const isHeld = (latest: Option.Option<RestoreRecord>) => Option.isSome(latest) && latest.value.resumedAt === null;

/** Holds work while the latest restore is not resumed (ADR 026). */
export const WorkHoldLive = Layer.effect(
  WorkHold,
  Effect.gen(function* () {
    const held = yield* Ref.make(isHeld(yield* (yield* RestoreRepository).latest));
    return WorkHold.of({ held: Ref.get(held), release: Ref.set(held, false) });
  }),
);

/** Settings › Backup & export › Restore, and what the latest restore left (ADR 026). */
export class HubRestores extends Context.Service<
  HubRestores,
  {
    readonly status: Effect.Effect<RestoreStatus>;
    readonly inspect: (path: string) => Effect.Effect<RestoreSummary, RestoreRefused>;
    readonly restore: (path: string) => Effect.Effect<RestoreSummary, RestoreRefused>;
    readonly resume: Effect.Effect<RestoreStatus>;
    readonly deleteSetAside: Effect.Effect<RestoreStatus>;
  }
>()("@hobbots/server/HubRestores") {
  static readonly layer = Layer.effect(
    HubRestores,
    Effect.gen(function* () {
      const repo = yield* RestoreRepository;
      const hold = yield* WorkHold;
      const chat = yield* ChatService;
      const hobs = yield* HobbotsRepository;
      const identity = yield* Installation;
      const restart = yield* Effect.serviceOption(HubRestart);
      const outcome = yield* Effect.serviceOption(RestoreOutcome);
      const failed = Option.isSome(outcome) ? outcome.value.failed : null;

      const status: Effect.Effect<RestoreStatus> = Effect.gen(function* () {
        const latest = yield* repo.latest;
        if (Option.isNone(latest)) return { latest: null, failed };
        const restore = latest.value;
        const setAside =
          restore.setAside === null
            ? null
            : { path: restore.setAside, size: yield* Effect.promise(() => sizeOf(restore.setAside as string)) };
        return {
          latest: {
            restoredAt: restore.restoredAt,
            backupMadeAt: restore.backupMadeAt,
            backupVersion: restore.backupVersion,
            setAside,
            missingFolders: restore.missingFolders,
            workHeld: yield* hold.held,
          },
          failed,
        };
      });

      const inspect = (path: string) => Effect.flatMap(checkBackup(path), (manifest) => summaryOf(path, manifest));

      const restore = (path: string) =>
        Effect.gen(function* () {
          if (Option.isNone(restart)) {
            return yield* new RestoreRefused({
              reason: "This hub cannot restart itself. Stop it and run its restore command instead.",
            });
          }
          const summary = yield* inspect(path);
          // The answer leaves before the hub stops.
          yield* restart.value.restore(path).pipe(Effect.delay("300 millis"), Effect.forkDetach);
          return summary;
        });

      // Work that waited starts again through the same paths as after any start.
      const resume = Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* repo.resume(now);
        yield* hold.release;
        for (const hob of yield* hobs.listAgentsWithStatus(["active"])) yield* chat.drainAgent(hob.id);
        return yield* status;
      });

      // Only the folder the restore set aside, beside this data folder.
      const deleteSetAside = Effect.gen(function* () {
        const latest = yield* repo.latest;
        const folder = Option.isSome(latest) ? latest.value.setAside : null;
        if (
          folder !== null &&
          dirname(folder) === dirname(identity.dataDir) &&
          basename(folder).startsWith(`${basename(identity.dataDir)}.before-restore-`)
        ) {
          yield* Effect.promise(() => rm(folder, { recursive: true, force: true }));
        }
        yield* repo.clearSetAside;
        return yield* status;
      });

      return HubRestores.of({ status, inspect, restore, resume, deleteSetAside });
    }),
  );
}
