import {
  type ActivityLimits,
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
  foldersOverlap,
  foldLog,
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

/** A turn running now, for labeling changes made while another turn worked in the same folder. */
interface LiveTurn {
  readonly folders: ReadonlyArray<string>;
  attemptId: AttemptId | null;
  readonly overlaps: Set<LiveTurn>;
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

/**
 * The changes as an Attempt keeps them: contents past what it may keep are dropped, in path order,
 * and say so. `sizes` are the bytes of each kept content.
 */
const withinBudget = (
  drafts: ReadonlyArray<FileChangeDraft>,
  sizes: ReadonlyMap<ContentId, number>,
  limit: number,
): ReadonlyArray<FileChangeDraft> => {
  const counted = new Set<ContentId>();
  let used = 0;
  const fit = (version: FileVersion | null): FileVersion | null => {
    if (version?.contentId == null || counted.has(version.contentId)) return version;
    const size = sizes.get(version.contentId) ?? 0;
    if (used + size > limit) return { ...version, contentId: null, notKept: "attempt-limit" };
    used += size;
    counted.add(version.contentId);
    return version;
  };
  return drafts.map((draft) => ({ ...draft, before: fit(draft.before), after: fit(draft.after) }));
};

const makeRecorder = (limits: ActivityLimits) =>
  Effect.gen(function* () {
    const scanner = yield* FolderScanner;
    const store = yield* ActivityStore;
    const repo = yield* ActivityRepository;
    const publisher = yield* EventPublisher;
    const live = new Set<LiveTurn>();
    // Contents a live turn may still point at, so neither another turn nor pruning drops them.
    const pinned = new Map<ContentId, number>();
    // What each file hash was kept as, so a file kept before is not read again while it is kept.
    const kept = new Map<
      string,
      { readonly id: ContentId; readonly kind: FileVersion["kind"]; readonly size: number }
    >();

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
        const me: LiveTurn = { folders: turn.folders, attemptId: null, overlaps: new Set() };
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
        const added = new Set<ContentId>();
        const sizes = new Map<ContentId, number>();
        const scans: Array<Omit<FolderScanDraft, "attemptId">> = [];
        const commands = new Map<string, Omit<CommandDraft, "attemptId">>();
        const dirtyCommands = new Set<string>();
        const printed = new Map<string, string>();
        const changeSets = new Map<string, ReadonlyArray<FileChangeDraft>>();
        const dirtyFolders = new Set<string>();
        const changeIds = new Map<string, FileChangeId>();
        const writers = new Set<string>();
        let logsUsed = 0;
        let taskId: TaskId | null = null;
        // Contents read at the start, bounded like an Attempt's own.
        let baselineUsed = 0;

        /** Keeps a version of a file, reading it once per content hash while it is kept. */
        const keepVersion = (folder: string, path: string, file: ScannedFile, atStart: boolean) =>
          Effect.gen(function* () {
            const plan = keepPlan(path, file, limits);
            if (plan.readUpTo === null) return withoutContents(file, plan.kind, plan.notKept);
            const known = kept.get(file.hash);
            if (known !== undefined && (yield* store.has(known.id))) {
              sizes.set(known.id, known.size);
              if (!added.has(known.id)) {
                added.add(known.id);
                pin(known.id);
              }
              return { ...withoutContents(file, known.kind, null), contentId: known.id };
            }
            if (atStart && baselineUsed + file.size > limits.contentsPerAttempt) {
              return withoutContents(file, plan.kind, "attempt-limit");
            }
            const bytes = yield* scanner.read(folder, path, plan.readUpTo);
            if (Option.isNone(bytes)) return withoutContents(file, plan.kind, "unreadable");
            const text = plan.kind === "image" ? null : textOf(bytes.value);
            if (plan.kind !== "image" && text === null) return withoutContents(file, "other", "not-shown");
            const content = text === null ? bytes.value : encoder.encode(turn.redactor.text(text));
            const stored = yield* store.put(content).pipe(Effect.option);
            if (Option.isNone(stored)) return withoutContents(file, plan.kind, "unreadable");
            const id = stored.value.id;
            if (atStart) baselineUsed += content.byteLength;
            sizes.set(id, content.byteLength);
            kept.set(file.hash, { id, kind: plan.kind, size: content.byteLength });
            if (!added.has(id)) {
              added.add(id);
              pin(id);
            }
            return { ...withoutContents(file, plan.kind, null), contentId: id };
          });

        /** The Attempts that worked in `folder` alongside this turn. */
        const sharedIn = (folder: string): ReadonlyArray<AttemptId> => [
          ...new Set(
            [...me.overlaps].flatMap((other) =>
              other.attemptId !== null && other.folders.some((each) => foldersOverlap(each, folder))
                ? [other.attemptId]
                : [],
            ),
          ),
        ];

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
            const after = change.after === null ? null : yield* keepVersion(folder, change.path, change.after, false);
            return {
              id,
              path: change.path,
              kind: change.kind,
              movedFrom: change.movedFrom,
              before,
              after,
              sharedWith: sharedIn(folder),
              settled,
              recordedAt: at,
            } satisfies FileChangeDraft;
          });

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
                const drafts = yield* Effect.forEach(compareListings(baseline.listing, scanned.listing), (change) =>
                  draftOf(folder, baseline, change, settled, at),
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
          ).pipe(Effect.andThen(sync));

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
              const drafts = withinBudget(changeSets.get(folder) ?? [], sizes, limits.contentsPerAttempt);
              const saved = yield* repo.saveChanges(attemptId, folder, drafts);
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

        const started = (event: ToolStartedEvent) =>
          Effect.gen(function* () {
            if (event.operation === "edit-files" || event.operation === "delete-files") writers.add(event.id);
            if (event.command === undefined || commands.has(event.id)) return;
            commands.set(event.id, {
              id: CommandId.make(newId()),
              stepId: event.id,
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
            if (!added.has(stored.value.id)) {
              added.add(stored.value.id);
              pin(stored.value.id);
            }
            return {
              output: { ...preview, logged: true },
              log: { contentId: stored.value.id, totalBytes: folded.totalBytes, omittedBytes: folded.omittedBytes },
              logNotKept: null,
            };
          });

        const finished = (event: Extract<RuntimeEvent, { readonly _tag: "ToolFinished" }>) =>
          Effect.gen(function* () {
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
                state: event.failed ? "failed" : "succeeded",
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
              return started(event);
            case "ToolOutput":
              return printing(event.id, event.text);
            case "ToolFinished":
              return finished(event);
            case "ToolUncertain":
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
                ([path, file]) =>
                  Effect.map(keepVersion(folder, path, file, true), (version) => versions.set(path, version)),
                { concurrency: 8, discard: true },
              );
            }
            baselines.set(folder, { listing: scanned.listing, stopped: scanned.stopped, versions });
          });

        /** The end of the turn: running commands are uncertain, the compare is recorded, loose contents dropped. */
        const end = Effect.gen(function* () {
          const at = yield* nowIso;
          for (const id of commands.keys()) uncertain(id, at);
          yield* Semaphore.withPermit(scanLock, compare(true));
          live.delete(me);
          const mine = [...added];
          for (const id of mine) unpin(id);
          yield* dropUnnamed(mine);
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
                        recorded ? observe(event) : Effect.void,
                      ),
            }).pipe(Stream.tap(observe)),
        } satisfies TurnActivity;
      });

    const prune = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, Duration.days(limits.retentionDays)));
      const cleared = yield* repo.clearDetails(cutoff, DateTime.formatIso(now));
      if (cleared > 0) yield* Effect.logDebug(`Cleared the details of ${cleared} Workbench records`);
      yield* dropUnnamed(yield* store.list);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not prune the Workbench's details", cause)));

    return ActivityRecorder.of({ forTurn, prune });
  });
