import type {
  ActivityLimits,
  AttemptActivity,
  AttemptId,
  CommandId,
  CommandRecord,
  Committed,
  ContentId,
  FileChange,
  FileChangeId,
  FolderListing,
  FolderScan,
  ScanStop,
} from "@hobbots/domain";
import { Context, type Effect, type Option, Schema } from "effect";

/**
 * The ports the Workbench's records go through (ADR 023): what lists a hob's folders, where the
 * heavy details are kept, and where the records are stored.
 */

/** A folder as a scan found it: its files, unless tracking stopped for it, and why. */
export interface ScannedFolder {
  readonly listing: FolderListing;
  readonly filesScanned: number;
  readonly stopped: ScanStop | null;
}

export interface FolderScannerShape {
  /**
   * Lists every file in `folder` with its content hash. It reads the files themselves: it never runs
   * Git or anything else from the folder, never follows a link, and skips `.git`, `node_modules` and,
   * in a Git folder, what its `.gitignore` files ignore. It stops past the file or time limit.
   */
  readonly scan: (
    folder: string,
    limits: Pick<ActivityLimits, "maxFiles" | "scanTimeoutMs">,
  ) => Effect.Effect<ScannedFolder>;
  /**
   * The first `maxBytes` of `path` inside `folder`, as it is now; none when it is not a regular file
   * inside the folder or cannot be read.
   */
  readonly read: (folder: string, path: string, maxBytes: number) => Effect.Effect<Option.Option<Uint8Array>>;
}

/** Lists the hob's folders on the hub, for the changes a turn made. */
export class FolderScanner extends Context.Service<FolderScanner, FolderScannerShape>()(
  "@hobbots/agents/FolderScanner",
) {}

export class ActivityStoreUnavailable extends Schema.TaggedError<ActivityStoreUnavailable>()(
  "ActivityStoreUnavailable",
  { message: Schema.String },
) {}

export interface ActivityStoreShape {
  /** Keeps `bytes` under their SHA-256, once; `added` is false when they were already kept. */
  readonly put: (
    bytes: Uint8Array,
  ) => Effect.Effect<{ readonly id: ContentId; readonly added: boolean }, ActivityStoreUnavailable>;
  readonly has: (id: ContentId) => Effect.Effect<boolean>;
  /** The kept bytes, or none when they are not kept. */
  readonly get: (id: ContentId) => Effect.Effect<Option.Option<Uint8Array>>;
  /** Every id kept. */
  readonly list: Effect.Effect<ReadonlyArray<ContentId>>;
  readonly remove: (ids: ReadonlyArray<ContentId>) => Effect.Effect<void>;
}

/**
 * Where the hub keeps command logs and file contents, in its data folder, out of every hob's reach,
 * once per content hash.
 */
export class ActivityStore extends Context.Service<ActivityStore, ActivityStoreShape>()(
  "@hobbots/agents/ActivityStore",
) {}

/** A command as a turn records it, before the store names its Task. */
export type CommandDraft = Omit<CommandRecord, "taskId">;

/** A file change as a turn records it, before the store names its Attempt and Task. */
export type FileChangeDraft = Omit<FileChange, "taskId" | "attemptId" | "folder">;

/** A folder scan as a turn records it, before the store names its Task. */
export type FolderScanDraft = Omit<FolderScan, "taskId">;

export interface ActivityRepositoryShape {
  /**
   * Stores a command as it is now, new or changed, with its journal event. None when its Attempt is
   * not there.
   */
  readonly saveCommand: (command: CommandDraft) => Effect.Effect<Option.Option<Committed<CommandRecord>>>;
  /**
   * Stores the Attempt's changes in `folder` as a scan found them: each is added or replaces the one
   * at its path, and the Attempt's other changes in the folder are removed. None when its Attempt
   * is not there.
   */
  readonly saveChanges: (
    attemptId: AttemptId,
    folder: string,
    changes: ReadonlyArray<FileChangeDraft>,
  ) => Effect.Effect<
    Option.Option<
      Committed<{ readonly changes: ReadonlyArray<FileChange>; readonly removed: ReadonlyArray<FileChangeId> }>
    >
  >;
  readonly saveScan: (scan: FolderScanDraft) => Effect.Effect<Option.Option<Committed<FolderScan>>>;
  readonly read: (attemptId: AttemptId) => Effect.Effect<Option.Option<AttemptActivity>>;
  /** Whether a record of the Attempt names these contents, and they were not cleared. */
  readonly names: (attemptId: AttemptId, contentId: ContentId) => Effect.Effect<boolean>;
  /** The command, when it is the Attempt's. */
  readonly findCommand: (attemptId: AttemptId, commandId: CommandId) => Effect.Effect<Option.Option<CommandRecord>>;
  /** Every command still recorded as running: after a restart, none of them still runs. */
  readonly unfinishedCommands: Effect.Effect<ReadonlyArray<CommandRecord>>;
  /** Of `ids`, those no record names. */
  readonly unnamed: (ids: ReadonlyArray<ContentId>) => Effect.Effect<ReadonlyArray<ContentId>>;
  /**
   * Clears the heavy details of every Attempt whose top Task ended before `endedBefore`: their
   * records stop naming logs and contents, and say when they were cleared. Returns how many records
   * it cleared.
   */
  readonly clearDetails: (endedBefore: string, at: string) => Effect.Effect<number>;
}

/** Stores the Workbench's records (ADR 023), each with its journal event. */
export class ActivityRepository extends Context.Service<ActivityRepository, ActivityRepositoryShape>()(
  "@hobbots/agents/ActivityRepository",
) {}
