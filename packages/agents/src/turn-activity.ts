import {
  type ActivityLimits,
  type AttemptActivity,
  type AttemptId,
  CommandId,
  type ContentId,
  compareListings,
  DEFAULT_ACTIVITY_LIMITS,
  type FileChangeId,
  FileChangeId as FileChangeIdSchema,
  type FileVersion,
  type FolderListing,
  FolderScanId,
  fileLocation,
  foldersOverlap,
  foldLog,
  type KeepPlan,
  keepPlan,
  type ListingChange,
  type NotKept,
  previewToolOutput,
  type ScannedFile,
  type ScanStop,
  type TaskId,
} from "@hobbots/domain";
import { Context, DateTime, Duration, Effect, Layer, Option, type Scope, Semaphore, Stream } from "effect";
import {
  ActivityRepository,
  ActivityStore,
  type ActivityStoreShape,
  type CommandDraft,
  type FileChangeDraft,
  type FolderScanDraft,
  FolderScanner,
} from "./activity.ts";
import { EventPublisher } from "./ports.ts";
import type { PromptRequest, RuntimeEvent, ToolStartedEvent } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";

/** One turn whose activity the hub records (ADR 023): its hob's folders and the Attempt it works on. */
export interface ActivityTurn {
  /** The hob's folders, canonical; empty for a turn without tools. */
  readonly folders: ReadonlyArray<string>;
  /**
   * The Attempt the turn works on: known from the start for a step or a member, and for a chat turn
   * once it starts one, or null until then. Records made before it is known wait for it, and are
   * dropped when the turn ends without one.
   */
  readonly attempt: Effect.Effect<AttemptId | null>;
  readonly redactor: Redactor;
}

export interface TurnActivity {
  /** Sends `request` with `send`, recording the commands it runs and the files they change. */
  readonly run: <E>(
    request: PromptRequest,
    send: (request: PromptRequest) => Stream.Stream<RuntimeEvent, E>,
  ) => Stream.Stream<RuntimeEvent, E>;
}

/** A turn whose activity is not recorded, as on a hub without the Workbench's records. */
export const UNTRACKED: TurnActivity = { run: (request, send) => send(request) };

export class ActivityRecorder extends Context.Service<
  ActivityRecorder,
  {
    /**
     * Takes the baseline of the turn's folders now. Closing the scope, however the turn ended,
     * records the end-of-turn compare, which is the record that counts.
     */
    readonly forTurn: (turn: ActivityTurn) => Effect.Effect<TurnActivity, never, Scope.Scope>;
    /** Clears the details past the retention window and drops kept contents no record names. */
    readonly prune: Effect.Effect<void>;
    /**
     * Records now what the live turn on `attemptId` changed so far, rather than when its scan
     * waiting to run gets to it, so a check made during the turn reads it (#586).
     */
    readonly settle: (attemptId: AttemptId) => Effect.Effect<void>;
  }
>()("@hobbots/agents/ActivityRecorder") {
  static readonly layer = (limits: ActivityLimits = DEFAULT_ACTIVITY_LIMITS) =>
    Layer.effect(ActivityRecorder, makeRecorder(limits));
}

/** The turn's activity: recorded when the hub records activity and the turn has folders, untracked otherwise. */
export const trackTurn = (
  recorder: Option.Option<ActivityRecorder["Service"]>,
  turn: ActivityTurn,
): Effect.Effect<TurnActivity, never, Scope.Scope> =>
  Option.isSome(recorder) && turn.folders.length > 0 ? recorder.value.forTurn(turn) : Effect.succeed(UNTRACKED);

/**
 * A turn running now, and what it claims to have changed, so overlapping turns in one folder each
 * record only their own changes (#595).
 */
interface LiveTurn {
  readonly folders: ReadonlyArray<string>;
  attemptId: AttemptId | null;
  readonly overlaps: Set<LiveTurn>;
  /** The files its file tools named, as `folder/path`, each with the tick it was last named at. */
  readonly named: Map<string, number>;
  /** The files its file tools are changing now, by call. */
  readonly writing: Map<string, ReadonlyArray<string>>;
  /** Every file it claims: those its file tools named, and those that changed while its commands ran. */
  readonly claims: Set<string>;
  /** When each of its commands ran, in ticks; `closed` is null while it runs. */
  readonly spans: Array<Span>;
  /** Records the changes made so far now, if the turn works on `attemptId` (#586). */
  settle: (attemptId: AttemptId) => Effect.Effect<void>;
}

/** When a command ran, in the recorder's ticks. */
interface Span {
  readonly opened: number;
  closed: number | null;
}

/** A folder at the turn's start: its files and the versions kept of them, or why it is not tracked. */
interface Baseline {
  readonly listing: FolderListing;
  readonly stopped: ScanStop | null;
  readonly versions: Map<string, FileVersion>;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** `bytes` as text when they are valid UTF-8 with no NUL character, as a text file's are; else null. */
export const textOf = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/** Where a change is, as `folder/path`, and where a moved file was. */
const placesOf = (folder: string, change: ListingChange): ReadonlyArray<string> => [
  fileLocation(folder, change.path),
  ...(change.movedFrom === null ? [] : [fileLocation(folder, change.movedFrom)]),
];

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const encoder = new TextEncoder();
const newId = () => crypto.randomUUID();

/** A version kept with no contents, and why. */
const withoutContents = (file: ScannedFile, kind: FileVersion["kind"], notKept: NotKept | null): FileVersion => ({
  hash: file.hash,
  size: file.size,
  kind,
  contentId: null,
  notKept,
});

/** A file content a turn keeps: its id, its kind, and its bytes as stored. */
interface KeptContent {
  readonly id: ContentId;
  readonly kind: FileVersion["kind"];
  readonly size: number;
}

/**
 * What an Attempt's records already keep: each file content its changes name, once, by the file
 * hash it was kept for, with its bytes as stored, and the bytes of its commands' logs. A turn that
 * resumes the Attempt counts them against its budgets. A text content is stored redacted, which can
 * make it longer than the file, so its bytes are read from the store; an image is stored as it is.
 */
const attemptUse = (store: ActivityStoreShape, activity: AttemptActivity) =>
  Effect.gen(function* () {
    const contents = new Map<string, KeptContent>();
    for (const change of activity.changes) {
      for (const version of [change.before, change.after]) {
        if (!version?.contentId || contents.has(version.hash)) continue;
        const size =
          version.kind === "image"
            ? Option.some(version.size)
            : Option.map(yield* store.get(version.contentId), (bytes) => bytes.byteLength);
        if (Option.isSome(size))
          contents.set(version.hash, { id: version.contentId, kind: version.kind, size: size.value });
      }
    }
    let logs = 0;
    for (const command of activity.commands) {
      if (command.log !== null) logs += command.log.totalBytes - command.log.omittedBytes;
    }
    return { contents, logs };
  });

const makeRecorder = (limits: ActivityLimits) =>
  Effect.gen(function* () {
    const scanner = yield* FolderScanner;
    const store = yield* ActivityStore;
    const repo = yield* ActivityRepository;
    const publisher = yield* EventPublisher;
    const live = new Set<LiveTurn>();
    // A count that orders what every live turn does: file tools naming files, commands starting and ending.
    let ticks = 0;
    const tick = () => ++ticks;
    // Contents a live turn may still point at, so neither another turn nor pruning drops them.
    const pinned = new Map<ContentId, number>();
    // What each file hash was kept as, so a file kept before is not read again while it is kept.
    const kept = new Map<string, KeptContent>();

    const pin = (id: ContentId) => pinned.set(id, (pinned.get(id) ?? 0) + 1);
    const unpin = (id: ContentId) => {
      const count = (pinned.get(id) ?? 0) - 1;
      if (count > 0) pinned.set(id, count);
      else pinned.delete(id);
    };

    /** Drops kept contents no record names and no live turn may still point at. */
    const dropUnnamed = (ids: ReadonlyArray<ContentId>) =>
      Effect.gen(function* () {
        const loose = ids.filter((id) => !pinned.has(id));
        if (loose.length === 0) return;
        yield* store.remove(yield* repo.unnamed(loose));
      });

    const forTurn = (turn: ActivityTurn) =>
      Effect.gen(function* () {
        const me: LiveTurn = {
          folders: turn.folders,
          attemptId: null,
          overlaps: new Set(),
          named: new Map(),
          writing: new Map(),
          claims: new Set(),
          spans: [],
          settle: () => Effect.void,
        };
        // A later turn of the same Attempt keeps what the turns before it recorded.
        const turnStarted = yield* nowIso;
        // Its own commands' records are told apart from theirs, as a runtime may reuse step ids.
        const turnKey = newId();
        for (const other of live) {
          if (other.folders.some((folder) => turn.folders.some((mine) => foldersOverlap(folder, mine)))) {
            other.overlaps.add(me);
            me.overlaps.add(other);
          }
        }
        live.add(me);

        const scope = yield* Effect.scope;
        const lock = yield* Semaphore.make(1);
        const scanLock = yield* Semaphore.make(1);
        const baselines = new Map<string, Baseline>();
        // Contents this turn keeps pinned, so neither another turn nor pruning drops them while it runs.
        const mine = new Set<ContentId>();
        // The file contents the Attempt holds now, and their bytes: one budget for every folder,
        // reserved before a content is stored, and freed when a later scan no longer needs one.
        const held = new Map<ContentId, number>();
        let heldBytes = 0;
        // Contents freed since the last write, dropped once no record names them.
        const freed = new Set<ContentId>();
        const scans: Array<Omit<FolderScanDraft, "attemptId">> = [];
        const commands = new Map<string, Omit<CommandDraft, "attemptId">>();
        const dirtyCommands = new Set<string>();
        const printed = new Map<string, string>();
        const changeSets = new Map<string, ReadonlyArray<FileChangeDraft>>();
        const dirtyFolders = new Set<string>();
        const changeIds = new Map<string, FileChangeId>();
        const writers = new Set<string>();
        // Each running command's folders as they were just before it ran, to see what it changed.
        const windows = new Map<
          string,
          { readonly span: Span; readonly listings: ReadonlyArray<readonly [string, FolderListing]> }
        >();
        // The other turns whose commands ran while one of this turn's commands changed a file: either may have made it.
        const contested = new Map<string, Set<LiveTurn>>();
        // Folders whose changes could not be told apart from other hobs', recorded whole and labeled.
        const unattributed = new Set<string>();
        let logsUsed = 0;
        let taskId: TaskId | null = null;
        // The Attempt's budgets hold across its turns: what earlier turns kept counts here, once,
        // and a file kept then is not read or counted again.
        const earlier = new Set<ContentId>();
        const resumed = yield* turn.attempt;
        const before = resumed === null ? Option.none() : yield* repo.read(resumed);
        if (Option.isSome(before)) {
          const use = yield* attemptUse(store, before.value);
          for (const [hash, content] of use.contents) {
            if (!kept.has(hash)) kept.set(hash, content);
            if (earlier.has(content.id)) continue;
            earlier.add(content.id);
            heldBytes += content.size;
          }
          logsUsed += use.logs;
        }

        const keep = (id: ContentId) => {
          if (mine.has(id)) return;
          mine.add(id);
          pin(id);
        };
        /** Holds `bytes` more for a content, or says no when the Attempt's budget would be passed. */
        const reserve = (bytes: number) => {
          if (heldBytes + bytes > limits.contentsPerAttempt) return false;
          heldBytes += bytes;
          return true;
        };
        /** Turns a reservation of `reserved` bytes into the content `id` of `size` bytes, counted once. */
        const settle = (reserved: number, id: ContentId, size: number) => {
          heldBytes -= reserved;
          if (held.has(id)) return;
          // An earlier turn's content is counted already.
          const bytes = earlier.has(id) ? 0 : size;
          held.set(id, bytes);
          heldBytes += bytes;
          keep(id);
        };

        /**
         * Reads a file's contents and stores them, redacted when they are text. `reserved` holds the
         * bytes reserved for it: redaction can make text longer, so what it adds is reserved before
         * anything is stored, or the content is not kept.
         */
        const readAndStore = (folder: string, path: string, plan: KeepPlan, reserved: { bytes: number }) =>
          Effect.gen(function* () {
            const bytes = yield* scanner.read(folder, path, Math.min(plan.readUpTo ?? 0, reserved.bytes));
            if (Option.isNone(bytes)) return { _tag: "NotKept", kind: plan.kind, why: "unreadable" } as const;
            const text = plan.kind === "image" ? null : textOf(bytes.value);
            if (plan.kind !== "image" && text === null)
              return { _tag: "NotKept", kind: "other", why: "not-shown" } as const;
            const content = text === null ? bytes.value : encoder.encode(turn.redactor.text(text));
            const more = content.byteLength - reserved.bytes;
            if (more > 0) {
              if (!reserve(more)) return { _tag: "NotKept", kind: plan.kind, why: "attempt-limit" } as const;
              reserved.bytes += more;
            }
            const stored = yield* store.put(content).pipe(Effect.option);
            if (Option.isNone(stored)) return { _tag: "NotKept", kind: plan.kind, why: "unreadable" } as const;
            return { _tag: "Kept", id: stored.value.id, size: content.byteLength } as const;
          });

        /** Keeps a version of a file, reading it once per content hash while it is kept. */
        const keepVersion = (folder: string, path: string, file: ScannedFile) =>
          Effect.gen(function* () {
            const plan = keepPlan(path, file, limits);
            if (plan.readUpTo === null) return withoutContents(file, plan.kind, plan.notKept);
            const known = kept.get(file.hash);
            if (known !== undefined && (yield* store.has(known.id))) {
              const counted = held.has(known.id) || earlier.has(known.id);
              if (!counted && !reserve(known.size)) return withoutContents(file, known.kind, "attempt-limit");
              if (!held.has(known.id)) settle(counted ? 0 : known.size, known.id, known.size);
              return { ...withoutContents(file, known.kind, null), contentId: known.id };
            }
            // The file's size as scanned is reserved before it is read, so no read passes the budget.
            if (!reserve(file.size)) return withoutContents(file, plan.kind, "attempt-limit");
            // A read cut short, as by the turn's end, gives its reservation back.
            const reserved = { bytes: file.size };
            const stored = yield* readAndStore(folder, path, plan, reserved).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  heldBytes -= reserved.bytes;
                }),
              ),
            );
            if (stored._tag === "NotKept") {
              heldBytes -= reserved.bytes;
              return withoutContents(file, stored.kind, stored.why);
            }
            const id = stored.id;
            settle(reserved.bytes, id, stored.size);
            kept.set(file.hash, { id, kind: plan.kind, size: stored.size });
            return { ...withoutContents(file, plan.kind, null), contentId: id };
          });

        /**
         * The Attempts that may share a change with this turn: those that claim the same file, or in a
         * folder recorded whole, every one that worked in it alongside this turn.
         */
        const sharedIn = (folder: string, change: ListingChange): ReadonlyArray<AttemptId> => {
          const places = placesOf(folder, change);
          return [
            ...new Set(
              [...me.overlaps].flatMap((other) =>
                other.attemptId !== null &&
                (unattributed.has(folder)
                  ? other.folders.some((each) => foldersOverlap(each, folder))
                  : places.some((place) => other.claims.has(place) || contested.get(place)?.has(other)))
                  ? [other.attemptId]
                  : [],
              ),
            ),
          ];
        };

        /** Whether the turn made `change`: it claims the file, or its folder is recorded whole. */
        const ownChange = (folder: string, change: ListingChange) =>
          unattributed.has(folder) || placesOf(folder, change).some((place) => me.claims.has(place));

        /** Whether another turn's file tool changed `place` while the command of `span` ran. */
        const namedByAnother = (place: string, span: Span) =>
          [...me.overlaps].some(
            (other) =>
              (other.named.get(place) ?? 0) > span.opened ||
              [...other.writing.values()].some((targets) => targets.includes(place)),
          );

        /** The other turns with a command that ran at some point while the command of `span` ran. */
        const runningBeside = (span: Span) =>
          [...me.overlaps].filter((other) =>
            other.spans.some(
              (each) => each.opened < (span.closed ?? ticks) && (each.closed === null || each.closed > span.opened),
            ),
          );

        /**
         * Claims what a command changed between its start and now, less the files another turn's file
         * tools changed meanwhile. A file a command of another turn may have made too is marked contested.
         */
        const claimWindow = (id: string) =>
          Effect.gen(function* () {
            const window = windows.get(id);
            if (window === undefined) return;
            windows.delete(id);
            const scanned = yield* Effect.forEach(window.listings, ([folder, before]) =>
              Effect.map(scanner.scan(folder, limits), (after) => ({ folder, before, after })),
            );
            window.span.closed = tick();
            const beside = runningBeside(window.span);
            for (const { folder, before, after } of scanned) {
              if (after.stopped !== null) {
                unattributed.add(folder);
                continue;
              }
              for (const change of compareListings(before, after.listing))
                for (const place of placesOf(folder, change)) {
                  if (namedByAnother(place, window.span)) continue;
                  me.claims.add(place);
                  // Only a turn that tracks the file's folder could have made it.
                  for (const other of beside)
                    if (other.folders.some((each) => foldersOverlap(each, place)))
                      contested.set(place, (contested.get(place) ?? new Set()).add(other));
                }
            }
          });

        /** A change as the turn records it, with the versions it keeps. */
        const draftOf = (folder: string, baseline: Baseline, change: ListingChange, settled: boolean, at: string) =>
          Effect.gen(function* () {
            const key = `${folder}\0${change.path}`;
            const id = changeIds.get(key) ?? FileChangeIdSchema.make(newId());
            changeIds.set(key, id);
            const wasAt = change.movedFrom ?? change.path;
            const before =
              change.before === null
                ? null
                : (baseline.versions.get(wasAt) ?? withoutContents(change.before, "other", "unreadable"));
            const after = change.after === null ? null : yield* keepVersion(folder, change.path, change.after);
            return {
              id,
              path: change.path,
              kind: change.kind,
              movedFrom: change.movedFrom,
              before,
              after,
              sharedWith: sharedIn(folder, change),
              settled,
              recordedAt: at,
            } satisfies FileChangeDraft;
          });

        /**
         * Frees the contents no baseline or current change needs any more, such as the version of a
         * file a later rewrite replaced, so a long turn holds only what its records can show.
         */
        const release = (rescanning?: string): ReadonlyArray<ContentId> => {
          const needed = new Set<ContentId | null>();
          for (const baseline of baselines.values())
            for (const version of baseline.versions.values()) needed.add(version.contentId);
          for (const [folder, drafts] of changeSets) {
            if (folder === rescanning) continue;
            for (const draft of drafts) {
              needed.add(draft.before?.contentId ?? null);
              needed.add(draft.after?.contentId ?? null);
            }
          }
          const freed = [...held.keys()].filter((id) => !needed.has(id));
          for (const id of freed) {
            heldBytes -= held.get(id) ?? 0;
            held.delete(id);
            mine.delete(id);
            unpin(id);
          }
          return freed;
        };

        /** Records the turn's changes in every tracked folder as they are now, and each folder's end scan. */
        const compare = (settled: boolean) =>
          Effect.forEach(
            [...baselines],
            ([folder, baseline]) =>
              Effect.gen(function* () {
                if (baseline.stopped !== null) return;
                const startedAt = yield* nowIso;
                const scanned = yield* scanner.scan(folder, limits);
                const at = yield* nowIso;
                if (settled || scanned.stopped !== null) {
                  scans.push(scanDraft(folder, "end", scanned.filesScanned, scanned.stopped, startedAt, at));
                }
                if (scanned.stopped !== null) return;
                // What this folder's last changes held is freed first, so the new ones can use it.
                for (const id of release(folder)) freed.add(id);
                const drafts = yield* Effect.forEach(
                  compareListings(baseline.listing, scanned.listing).filter((change) => ownChange(folder, change)),
                  (change) => draftOf(folder, baseline, change, settled, at),
                );
                yield* Semaphore.withPermit(
                  lock,
                  Effect.sync(() => {
                    changeSets.set(folder, drafts);
                    dirtyFolders.add(folder);
                  }),
                );
              }),
            { discard: true },
          ).pipe(
            Effect.andThen(sync),
            Effect.andThen(
              Effect.suspend(() => {
                for (const id of release()) freed.add(id);
                const loose = [...freed].filter((id) => !held.has(id));
                freed.clear();
                return dropUnnamed(loose);
              }).pipe(
                Effect.catchCause((cause) => Effect.logWarning("Could not drop a turn's superseded contents", cause)),
              ),
            ),
          );

        const scanDraft = (
          folder: string,
          phase: "start" | "end",
          filesScanned: number,
          stopped: ScanStop | null,
          startedAt: string,
          endedAt: string,
        ) => ({ id: FolderScanId.make(newId()), folder, phase, filesScanned, stopped, startedAt, endedAt });

        /** Writes what the turn recorded since the last write, once the Attempt it works on is known. */
        const sync = Semaphore.withPermit(
          lock,
          Effect.gen(function* () {
            const attemptId = me.attemptId ?? (yield* turn.attempt);
            if (attemptId === null) return;
            me.attemptId = attemptId;
            const entries = [];
            for (const stepId of [...dirtyCommands]) {
              const command = commands.get(stepId);
              dirtyCommands.delete(stepId);
              if (command === undefined) continue;
              const saved = yield* repo.saveCommand({ ...command, attemptId });
              if (Option.isNone(saved)) continue;
              taskId = saved.value.value.taskId;
              entries.push(...saved.value.entries);
            }
            for (const folder of [...dirtyFolders]) {
              dirtyFolders.delete(folder);
              const drafts = changeSets.get(folder) ?? [];
              const saved = yield* repo.saveChanges(attemptId, folder, drafts, turnStarted);
              if (Option.isSome(saved)) entries.push(...saved.value.entries);
            }
            // The scans last: an end scan on the record means the changes it found are too.
            for (const scan of scans.splice(0)) {
              const saved = yield* repo.saveScan({ ...scan, attemptId });
              if (Option.isSome(saved)) entries.push(...saved.value.entries);
            }
            if (entries.length > 0) yield* publisher.publish(entries);
          }),
        ).pipe(
          // A write the turn's end interrupts would lose what it took off the dirty lists.
          Effect.uninterruptible,
          Effect.catchCause((cause) => Effect.logWarning("Could not record a turn's activity", cause)),
        );

        // Another hub call, such as `complete_task`, may need what the turn changed so far on the record now.
        me.settle = (attemptId) =>
          Effect.gen(function* () {
            if ((me.attemptId ?? (yield* turn.attempt)) !== attemptId) return;
            yield* Semaphore.withPermit(scanLock, compare(false));
          });

        /** Changes made so far, scanned once more after the scans already waiting. */
        let rescanWanted = false;
        const rescanLater = Effect.suspend(() => {
          if (rescanWanted) return Effect.void;
          rescanWanted = true;
          return Effect.forkIn(
            Semaphore.withPermit(
              scanLock,
              Effect.suspend(() => {
                rescanWanted = false;
                return compare(false);
              }),
            ),
            scope,
          ).pipe(Effect.asVoid);
        });

        /**
         * A tool call starting. `beforeRun` when the runtime waits for its start to be recorded before
         * running it, so the folders a command may change are listed first; a command reported only
         * once it runs leaves its folders recorded whole.
         */
        const started = (event: ToolStartedEvent, beforeRun: boolean) =>
          Effect.gen(function* () {
            if (event.operation === "edit-files" || event.operation === "delete-files") {
              writers.add(event.id);
              // A file tool names canonical paths, as the folders and `fileLocation` give them.
              const at = tick();
              me.writing.set(event.id, event.targets);
              for (const target of event.targets) {
                me.named.set(target, at);
                me.claims.add(target);
              }
            }
            if (event.command === undefined || commands.has(event.id)) return;
            if (beforeRun) yield* openWindow(event.id);
            else for (const folder of baselines.keys()) unattributed.add(folder);
            commands.set(event.id, {
              id: CommandId.make(newId()),
              stepId: `${turnKey}/${event.id}`,
              command: turn.redactor.text(event.command.line),
              folder: event.command.folder,
              sandboxed: event.command.sandboxed,
              liveOutput: event.command.liveOutput,
              state: "running",
              exitCode: null,
              startedAt: yield* nowIso,
              endedAt: null,
              output: null,
              log: null,
              logNotKept: null,
            });
            dirtyCommands.add(event.id);
            yield* sync;
          });

        /** What a running command printed, shown live. Each piece is redacted on its own before it is sent. */
        const printing = (id: string, text: string) =>
          Effect.gen(function* () {
            const command = commands.get(id);
            if (command === undefined) return;
            const so = printed.get(id) ?? "";
            const delta = turn.redactor.text(text);
            printed.set(id, so + delta);
            if (me.attemptId === null || taskId === null) return;
            yield* publisher.publishTransient({
              _tag: "CommandOutput",
              attemptId: me.attemptId,
              taskId,
              commandId: command.id,
              offset: so.length,
              delta,
            });
          });

        /** A command's whole output: its start and end on the record, all of it as a log while the Attempt may keep one. */
        const keepOutput = (whole: string) =>
          Effect.gen(function* () {
            const preview = previewToolOutput(whole);
            if (preview.omittedBytes === 0)
              return { output: { ...preview, logged: false }, log: null, logNotKept: null };
            const folded = foldLog(whole, limits.logBytes);
            const bytes = encoder.encode(folded.text);
            const stored =
              logsUsed + bytes.byteLength > limits.logsPerAttempt
                ? Option.none()
                : yield* store.put(bytes).pipe(Effect.option);
            if (Option.isNone(stored)) {
              const why: NotKept = logsUsed + bytes.byteLength > limits.logsPerAttempt ? "attempt-limit" : "unreadable";
              return { output: { ...preview, logged: false }, log: null, logNotKept: why };
            }
            logsUsed += bytes.byteLength;
            keep(stored.value.id);
            return {
              output: { ...preview, logged: true },
              log: { contentId: stored.value.id, totalBytes: folded.totalBytes, omittedBytes: folded.omittedBytes },
              logNotKept: null,
            };
          });

        /**
         * A file tool's call ended, however it ended: what it wrote is written by now, so its files
         * count as named then too, and a command running meanwhile does not claim them.
         */
        const stopWriting = (id: string) => {
          const targets = me.writing.get(id);
          me.writing.delete(id);
          if (targets === undefined) return;
          const at = tick();
          for (const target of targets) me.named.set(target, at);
        };

        /** Lists the tracked folders just before a command runs. */
        const openWindow = (id: string) =>
          Effect.gen(function* () {
            const span: Span = { opened: tick(), closed: null };
            me.spans.push(span);
            const listings: Array<readonly [string, FolderListing]> = [];
            for (const [folder, baseline] of baselines) {
              if (baseline.stopped !== null) continue;
              const before = yield* scanner.scan(folder, limits);
              if (before.stopped === null) listings.push([folder, before.listing]);
              else unattributed.add(folder);
            }
            windows.set(id, { span, listings });
          });

        const finished = (event: Extract<RuntimeEvent, { readonly _tag: "ToolFinished" }>) =>
          Effect.gen(function* () {
            yield* claimWindow(event.id);
            stopWriting(event.id);
            const wrote = writers.delete(event.id);
            const command = commands.get(event.id);
            if (command !== undefined) {
              const whole =
                event.output === undefined ? (printed.get(event.id) ?? "") : turn.redactor.text(event.output);
              printed.delete(event.id);
              const output = yield* keepOutput(whole);
              commands.set(event.id, {
                ...command,
                ...output,
                // A command that exits non-zero failed, whatever the runtime's own flag says (#591).
                state: event.failed || (event.exitCode ?? 0) !== 0 ? "failed" : "succeeded",
                exitCode: event.exitCode ?? null,
                endedAt: yield* nowIso,
              });
              dirtyCommands.add(event.id);
              yield* sync;
            }
            if (wrote || command !== undefined) yield* rescanLater;
          });

        const uncertain = (id: string, at: string) => {
          const command = commands.get(id);
          if (command === undefined || command.state !== "running") return;
          const whole = printed.get(id) ?? "";
          const preview = previewToolOutput(whole);
          commands.set(id, {
            ...command,
            state: "uncertain",
            endedAt: at,
            output: whole === "" ? null : { ...preview, logged: false },
          });
          dirtyCommands.add(id);
        };

        const observe = (event: RuntimeEvent): Effect.Effect<void> => {
          switch (event._tag) {
            case "ToolStarted":
              return started(event, false);
            case "ToolOutput":
              return printing(event.id, event.text);
            case "ToolFinished":
              return finished(event);
            case "ToolUncertain":
              stopWriting(event.id);
              return Effect.flatMap(nowIso, (at) => Effect.sync(() => uncertain(event.id, at))).pipe(
                Effect.andThen(sync),
              );
            default:
              return Effect.void;
          }
        };

        /** The baseline of one folder: its files, and the contents it may need to show. */
        const takeBaseline = (folder: string) =>
          Effect.gen(function* () {
            const startedAt = yield* nowIso;
            const scanned = yield* scanner.scan(folder, limits);
            const at = yield* nowIso;
            scans.push(scanDraft(folder, "start", scanned.filesScanned, scanned.stopped, startedAt, at));
            const versions = new Map<string, FileVersion>();
            if (scanned.stopped === null) {
              yield* Effect.forEach(
                [...scanned.listing],
                ([path, file]) => Effect.map(keepVersion(folder, path, file), (version) => versions.set(path, version)),
                { concurrency: 8, discard: true },
              );
            }
            baselines.set(folder, { listing: scanned.listing, stopped: scanned.stopped, versions });
          });

        /** The end of the turn: running commands are uncertain, the compare is recorded, loose contents dropped. */
        const end = Effect.gen(function* () {
          const at = yield* nowIso;
          for (const id of commands.keys()) uncertain(id, at);
          // A command still running when the turn ended claims what changed up to now.
          yield* Effect.forEach([...windows.keys()], claimWindow, { discard: true });
          // A file tool cut off with the turn may have written: its files count as named as it ends.
          for (const id of [...me.writing.keys()]) stopWriting(id);
          yield* Semaphore.withPermit(scanLock, compare(true));
          live.delete(me);
          const pinned = [...mine];
          for (const id of pinned) unpin(id);
          yield* dropUnnamed(pinned);
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Could not record the end of a turn's activity", cause)),
        );

        yield* Effect.forEach(turn.folders, takeBaseline, { discard: true });
        yield* sync;
        yield* Effect.addFinalizer(() => end);

        return {
          run: (request, send) =>
            send({
              ...request,
              // A call recorded before it runs is not reported again: its start is recorded here too.
              recordToolStart:
                request.recordToolStart == null
                  ? null
                  : (event) =>
                      Effect.tap(request.recordToolStart?.(event) ?? Effect.succeed(false), (recorded) =>
                        recorded ? started(event, true) : Effect.void,
                      ),
            }).pipe(Stream.tap(observe)),
        } satisfies TurnActivity;
      });

    // After a restart no command of an earlier run still runs (EX-004): each one left running may or
    // may not have finished, so it is recorded as uncertain, with its journal entry.
    yield* Effect.gen(function* () {
      const at = yield* nowIso;
      for (const command of yield* repo.unfinishedCommands) {
        const { taskId: _, ...draft } = command;
        const saved = yield* repo.saveCommand({ ...draft, state: "uncertain", endedAt: at });
        if (Option.isSome(saved)) yield* publisher.publish(saved.value.entries);
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not settle the commands left running", cause)));

    const prune = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, Duration.days(limits.retentionDays)));
      const cleared = yield* repo.clearDetails(cutoff, DateTime.formatIso(now));
      if (cleared > 0) yield* Effect.logDebug(`Cleared the details of ${cleared} Workbench records`);
      yield* dropUnnamed(yield* store.list);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not prune the Workbench's details", cause)));

    const settle = (attemptId: AttemptId) =>
      Effect.forEach([...live], (turn) => turn.settle(attemptId), { discard: true });

    return ActivityRecorder.of({ forTurn, prune, settle });
  });
