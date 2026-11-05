import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { InvalidFolder } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/** What a backup's copy is doing now, so Settings can show its progress. */
export const BackupStep = Schema.Literals(["database", "workspace", "activity", "tool-logs", "memory", "manifest"]);
export type BackupStep = typeof BackupStep.Type;

/**
 * Where Back up now stands (ADR 026). `Waiting` waits for replies that can write to the default
 * workspace to end, up to 10 minutes; `Copying` copies, with the bytes so far out of an estimate.
 */
export const BackupState = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Waiting", { turns: Schema.Int, since: Schema.String }),
  Schema.TaggedStruct("Copying", {
    step: BackupStep,
    copiedBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  Schema.TaggedStruct("Done", { path: Schema.String, size: Schema.Number, finishedAt: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: Schema.String, finishedAt: Schema.String }),
]);
export type BackupState = typeof BackupState.Type;

/** Where Back up now stands, and the folder on the hub it offers to save into. */
export const BackupStatus = Schema.Struct({ state: BackupState, defaultDestination: Schema.String });
export type BackupStatus = typeof BackupStatus.Type;

/** Makes a backup folder inside `destination`, a folder on the hub. */
export const StartBackupPayload = Schema.Struct({ destination: Schema.String });

/**
 * The backup did not start: one already runs, or the destination is inside the data folder itself.
 * A destination that is not a folder, or is inside a hob's folder, is refused as `InvalidFolder`.
 */
export class BackupRefused extends Schema.TaggedError<BackupRefused>()(
  "BackupRefused",
  { reason: Schema.String },
  { httpApiStatus: 409 },
) {}

/** What a backup holds, as its manifest says, read before a restore changes anything. */
export class RestoreSummary extends Schema.Class<RestoreSummary>("RestoreSummary")({
  path: Schema.String,
  createdAt: Schema.String,
  hobbotsVersion: Schema.String,
  schemaVersion: Schema.Int,
  hobs: Schema.Int,
  threads: Schema.Int,
  quests: Schema.Int,
  tasks: Schema.Int,
  /** The hob folders the backup names that are not on this computer. */
  missingFolders: Schema.Array(Schema.String),
}) {}

export const RestorePathPayload = Schema.Struct({ path: Schema.String });

/**
 * The backup cannot be restored, and nothing changed: it is not a backup, has no manifest, misses a
 * file or has a wrong checksum, or comes from a newer Hobbots.
 */
export class RestoreRefused extends Schema.TaggedError<RestoreRefused>()(
  "RestoreRefused",
  { reason: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Start over cannot begin, and nothing changed (#948). */
export class ResetRefused extends Schema.TaggedError<ResetRefused>()(
  "ResetRefused",
  { reason: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The data folder a restore set aside beside the restored one, until you delete it. */
export const SetAsideFolder = Schema.Struct({ path: Schema.String, size: Schema.Number });

/** The latest restore this hub came back from, and whether its work is still held. */
export const LatestRestore = Schema.Struct({
  restoredAt: Schema.String,
  backupMadeAt: Schema.String,
  backupVersion: Schema.String,
  setAside: Schema.NullOr(SetAsideFolder),
  missingFolders: Schema.Array(Schema.String),
  workHeld: Schema.Boolean,
});

export const RestoreStatus = Schema.Struct({
  latest: Schema.NullOr(LatestRestore),
  /** Why the last restore asked for did not happen; the hub kept its data. */
  failed: Schema.NullOr(Schema.String),
});
export type RestoreStatus = typeof RestoreStatus.Type;

/** Settings › Your data: Back up now and Restore (ADR 026), and Start over (#948). */
export class BackupGroup extends HttpApiGroup.make("backup")
  .add(
    HttpApiEndpoint.get("status", "/backup", { success: BackupStatus }),
    HttpApiEndpoint.post("start", "/backup", {
      payload: StartBackupPayload,
      success: BackupStatus,
      error: [BackupRefused, InvalidFolder],
    }),
    // Cancels a backup in progress; what it wrote is deleted.
    HttpApiEndpoint.delete("cancel", "/backup", { success: BackupStatus }),
    HttpApiEndpoint.get("restoreStatus", "/restore", { success: RestoreStatus }),
    HttpApiEndpoint.post("inspect", "/restore/inspect", {
      payload: RestorePathPayload,
      success: RestoreSummary,
      error: RestoreRefused,
    }),
    // Checks the backup again, then the hub stops, restores and starts again on the restored data.
    HttpApiEndpoint.post("restore", "/restore", {
      payload: RestorePathPayload,
      success: RestoreSummary,
      error: RestoreRefused,
    }),
    // Resume work: the dispatcher turns on and what waited starts.
    HttpApiEndpoint.post("resume", "/restore/resume", { success: RestoreStatus }),
    // Deletes the data folder the latest restore set aside.
    HttpApiEndpoint.delete("deleteSetAside", "/restore/set-aside", { success: RestoreStatus }),
    // Start over (#948): the hub forgets its keychain sign-ins, stops, deletes all of its data and
    // starts again empty, at First run.
    HttpApiEndpoint.post("reset", "/reset", { error: ResetRefused }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
