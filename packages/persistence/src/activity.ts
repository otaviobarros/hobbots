import { ActivityRepository, type CommandDraft, type FileChangeDraft, type FolderScanDraft } from "@hobbots/agents";
import {
  ArtifactRef,
  AttemptActivity,
  type AttemptId,
  CommandRecord,
  type ContentId,
  FileChange,
  type FileChangeId,
  FileVersion,
  FolderScan,
  type TaskId,
  ToolOutput,
} from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { byteOrder, oldestFirst } from "./order.ts";
import { int, json, makeTaskReads, type Row } from "./task-rows.ts";

// The Workbench's records (migration 0036_attempt_activity, ADR 023). Each write names an Attempt,
// takes its Task from the stored Attempt and commits with its journal event (ADR 013).

const bool = (value: unknown) => Number(value) === 1;

const encodeOutput = Schema.encodeSync(Schema.fromJsonString(ToolOutput));
const encodeVersion = Schema.encodeSync(Schema.fromJsonString(FileVersion));

const decodeCommands = Schema.decodeUnknownEffect(Schema.Array(CommandRecord));
const decodeChanges = Schema.decodeUnknownEffect(Schema.Array(FileChange));
const decodeScans = Schema.decodeUnknownEffect(Schema.Array(FolderScan));
const decodeArtifacts = Schema.decodeUnknownEffect(Schema.Array(ArtifactRef));

/** Rows the hub wrote decode; one that does not is a defect. */
const decoded =
  <A>(decode: (rows: ReadonlyArray<Row>) => Effect.Effect<A, Schema.SchemaError>) =>
  (rows: ReadonlyArray<Row>) =>
    Effect.orDie(decode(rows));

const commandFromRow = (row: Row) => ({
  id: row.id,
  attemptId: row.attemptId,
  taskId: row.taskId,
  stepId: row.stepId,
  command: row.command,
  folder: row.folder,
  sandboxed: bool(row.sandboxed),
  liveOutput: bool(row.liveOutput),
  state: row.state,
  exitCode: int(row.exitCode),
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  output: json(row.output),
  log:
    row.logTotalBytes == null
      ? null
      : {
          contentId: row.logContentId ?? null,
          totalBytes: int(row.logTotalBytes),
          omittedBytes: int(row.logOmittedBytes),
        },
  logNotKept: row.detailsClearedAt != null && row.logTotalBytes != null ? "cleared" : row.logNotKept,
});

/** A version whose contents were cleared past the retention window says so. */
const clearedVersion = (value: unknown, cleared: boolean) => {
  const version = json(value);
  return version === null || !cleared || version.contentId === null
    ? version
    : { ...version, contentId: null, notKept: "cleared" };
};

const changeFromRow = (row: Row) => ({
  id: row.id,
  attemptId: row.attemptId,
  taskId: row.taskId,
  folder: row.folder,
  path: row.path,
  kind: row.kind,
  movedFrom: row.movedFrom,
  before: clearedVersion(row.beforeVersion, row.detailsClearedAt != null),
  after: clearedVersion(row.afterVersion, row.detailsClearedAt != null),
  sharedWith: json(row.sharedWith),
  settled: bool(row.settled),
  recordedAt: row.recordedAt,
});

const scanFromRow = (row: Row) => ({ ...row, filesScanned: int(row.filesScanned) });

const changeColumns = (attemptId: AttemptId, taskId: TaskId, folder: string, change: FileChangeDraft) => ({
  id: change.id,
  attempt_id: attemptId,
  task_id: taskId,
  folder,
  path: change.path,
  kind: change.kind,
  moved_from: change.movedFrom,
  before_version: change.before === null ? null : encodeVersion(change.before),
  after_version: change.after === null ? null : encodeVersion(change.after),
  before_content_id: change.before?.contentId ?? null,
  after_content_id: change.after?.contentId ?? null,
  shared_with: JSON.stringify(change.sharedWith),
  settled: change.settled ? 1 : 0,
  recorded_at: change.recordedAt,
});

export const ActivityRepositoryLive = Layer.effect(
  ActivityRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const reads = makeTaskReads(sql);

    /** The Task of a stored Attempt. */
    const taskOf = (attemptId: AttemptId) =>
      Effect.map(reads.attempt(attemptId), (attempts) => attempts[0]?.taskId ?? null);

    const commandsIn = (rows: ReadonlyArray<Row>) => decoded(decodeCommands)(rows.map(commandFromRow));
    /** An Attempt's commands, in the order they started; only the one with that step or id when given. */
    const commandRows = (attemptId: AttemptId, only: { readonly stepId?: string; readonly id?: string } = {}) => {
      const filter =
        only.stepId !== undefined
          ? sql`AND step_id = ${only.stepId}`
          : only.id !== undefined
            ? sql`AND id = ${only.id}`
            : sql.literal("");
      return sql<Row>`SELECT * FROM attempt_commands WHERE attempt_id = ${attemptId} ${filter}
        ORDER BY ${byteOrder(sql, ["started_at", "id"])}`.pipe(Effect.flatMap(commandsIn));
    };

    const saveCommand = (command: CommandDraft) =>
      journaled(1, () =>
        Effect.gen(function* () {
          const taskId = yield* taskOf(command.attemptId);
          if (taskId === null) return null;
          const columns = {
            command: command.command,
            folder: command.folder,
            sandboxed: command.sandboxed ? 1 : 0,
            live_output: command.liveOutput ? 1 : 0,
            state: command.state,
            exit_code: command.exitCode,
            started_at: command.startedAt,
            ended_at: command.endedAt,
            output: command.output === null ? null : encodeOutput(command.output),
            log_content_id: command.log?.contentId ?? null,
            log_total_bytes: command.log?.totalBytes ?? null,
            log_omitted_bytes: command.log?.omittedBytes ?? null,
            log_not_kept: command.logNotKept,
          };
          yield* sql`INSERT INTO attempt_commands ${sql.insert({
            id: command.id,
            attempt_id: command.attemptId,
            task_id: taskId,
            step_id: command.stepId,
            ...columns,
          })}
            ON CONFLICT (attempt_id, step_id) DO UPDATE SET ${sql.update(columns)}`;
          const [saved] = yield* commandRows(command.attemptId, { stepId: command.stepId });
          if (saved === undefined) return null;
          return { value: saved, events: [{ _tag: "CommandRecorded" as const, command: saved }] };
        }),
      );

    const changeRows = (attemptId: AttemptId, folder: string) =>
      sql<Row>`SELECT * FROM attempt_file_changes WHERE attempt_id = ${attemptId} AND folder = ${folder}
        ORDER BY ${byteOrder(sql, ["path", "id"])}`.pipe(
        Effect.map((rows) => rows.map(changeFromRow)),
        Effect.flatMap(decoded(decodeChanges)),
      );

    const saveChanges = (attemptId: AttemptId, folder: string, changes: ReadonlyArray<FileChangeDraft>) =>
      journaled(1, () =>
        Effect.gen(function* () {
          const taskId = yield* taskOf(attemptId);
          if (taskId === null) return null;
          const before = yield* changeRows(attemptId, folder);
          const paths = new Set(changes.map((change) => change.path));
          const removed: Array<FileChangeId> = before.filter((row) => !paths.has(row.path)).map((row) => row.id);
          if (removed.length > 0) yield* sql`DELETE FROM attempt_file_changes WHERE ${sql.in("id", removed)}`;
          for (const change of changes) {
            const {
              id: _id,
              attempt_id: _attempt,
              task_id: _task,
              folder: _folder,
              path: _path,
              ...rest
            } = changeColumns(attemptId, taskId, folder, change);
            yield* sql`INSERT INTO attempt_file_changes ${sql.insert(changeColumns(attemptId, taskId, folder, change))}
              ON CONFLICT (attempt_id, folder, path) DO UPDATE SET ${sql.update(rest)}`;
          }
          const saved = (yield* changeRows(attemptId, folder)).filter((row) => paths.has(row.path));
          return {
            value: { changes: saved, removed },
            events: [{ _tag: "FileChangesRecorded" as const, attemptId, taskId, folder, changes: saved, removed }],
          };
        }),
      );

    const saveScan = (scan: FolderScanDraft) =>
      journaled(1, () =>
        Effect.gen(function* () {
          const taskId = yield* taskOf(scan.attemptId);
          if (taskId === null) return null;
          yield* sql`INSERT INTO attempt_folder_scans ${sql.insert({
            id: scan.id,
            attempt_id: scan.attemptId,
            task_id: taskId,
            folder: scan.folder,
            phase: scan.phase,
            files_scanned: scan.filesScanned,
            stopped: scan.stopped,
            started_at: scan.startedAt,
            ended_at: scan.endedAt,
          })}`;
          const saved = new FolderScan({ ...scan, taskId });
          return { value: saved, events: [{ _tag: "FolderScanned" as const, scan: saved }] };
        }),
      );

    const read = (attemptId: AttemptId) =>
      Effect.gen(function* () {
        const [attempt] = yield* reads.attempt(attemptId);
        if (attempt === undefined) return Option.none();
        const commands = yield* commandRows(attemptId);
        const changes = yield* sql<Row>`SELECT * FROM attempt_file_changes WHERE attempt_id = ${attemptId}
          ORDER BY ${byteOrder(sql, ["folder", "path", "id"])}`.pipe(
          Effect.map((rows) => rows.map(changeFromRow)),
          Effect.flatMap(decoded(decodeChanges)),
        );
        const scans = yield* sql<Row>`SELECT * FROM attempt_folder_scans WHERE attempt_id = ${attemptId}
          ORDER BY ${byteOrder(sql, ["started_at", "id"])}`.pipe(
          Effect.map((rows) => rows.map(scanFromRow)),
          Effect.flatMap(decoded(decodeScans)),
        );
        const artifacts = yield* sql<Row>`SELECT * FROM artifact_refs WHERE attempt_id = ${attemptId}
          ORDER BY ${oldestFirst(sql)}`.pipe(Effect.flatMap(decoded(decodeArtifacts)));
        const [cleared] = yield* sql<{ readonly at: string | null }>`SELECT MAX(at) AS at FROM (
            SELECT details_cleared_at AS at FROM attempt_commands WHERE attempt_id = ${attemptId}
            UNION ALL SELECT details_cleared_at AS at FROM attempt_file_changes WHERE attempt_id = ${attemptId}
          ) cleared`;
        return Option.some(
          new AttemptActivity({ attempt, commands, changes, scans, artifacts, detailsClearedAt: cleared?.at ?? null }),
        );
      });

    const names = (attemptId: AttemptId, contentId: ContentId) =>
      Effect.map(
        sql`SELECT 1 AS found FROM attempt_commands WHERE attempt_id = ${attemptId} AND log_content_id = ${contentId}
            AND details_cleared_at IS NULL
          UNION ALL SELECT 1 AS found FROM attempt_file_changes WHERE attempt_id = ${attemptId}
            AND (before_content_id = ${contentId} OR after_content_id = ${contentId}) AND details_cleared_at IS NULL`,
        (rows) => rows.length > 0,
      );

    const unfinishedCommands = sql<Row>`SELECT * FROM attempt_commands WHERE state = 'running'
      ORDER BY ${byteOrder(sql, ["started_at", "id"])}`.pipe(Effect.flatMap(commandsIn));

    const findCommand = (attemptId: AttemptId, commandId: string) =>
      Effect.map(commandRows(attemptId, { id: commandId }), (rows) => Option.fromUndefinedOr(rows[0]));

    /** Of `ids`, those no record names; asked in batches, so a long list never makes one huge query. */
    const unnamed = (ids: ReadonlyArray<ContentId>) =>
      Effect.gen(function* () {
        const named = new Set<string>();
        for (let from = 0; from < ids.length; from += 500) {
          const batch = ids.slice(from, from + 500);
          const rows = yield* sql<{ readonly id: string }>`
            SELECT log_content_id AS id FROM attempt_commands WHERE ${sql.in("log_content_id", batch)}
            UNION SELECT before_content_id AS id FROM attempt_file_changes WHERE ${sql.in("before_content_id", batch)}
            UNION SELECT after_content_id AS id FROM attempt_file_changes WHERE ${sql.in("after_content_id", batch)}`;
          for (const row of rows) named.add(row.id);
        }
        return ids.filter((id) => !named.has(id));
      });

    /**
     * Records whose top Task ended before `endedBefore` stop naming their details. A Task ends at its
     * last update once it is terminal, and the records of every Task in its tree go with it.
     */
    const clearDetails = (endedBefore: string, at: string) =>
      Effect.gen(function* () {
        const ended = sql`task_id IN (SELECT t.id FROM tasks t JOIN tasks r ON r.id = t.root_id
          WHERE r.state IN ('completed', 'failed', 'cancelled') AND r.updated_at < ${endedBefore})`;
        const commands = yield* sql`UPDATE attempt_commands SET log_content_id = NULL, details_cleared_at = ${at}
          WHERE details_cleared_at IS NULL AND ${ended} RETURNING id`;
        const changes = yield* sql`UPDATE attempt_file_changes
          SET before_content_id = NULL, after_content_id = NULL, details_cleared_at = ${at}
          WHERE details_cleared_at IS NULL AND ${ended} RETURNING id`;
        return commands.length + changes.length;
      }).pipe(sql.withTransaction);

    return ActivityRepository.of({
      saveCommand,
      saveChanges,
      saveScan,
      read: (attemptId) => Effect.orDie(read(attemptId)),
      names: (attemptId, contentId) => Effect.orDie(names(attemptId, contentId)),
      findCommand: (attemptId, commandId) => Effect.orDie(findCommand(attemptId, commandId)),
      unfinishedCommands: Effect.orDie(unfinishedCommands),
      unnamed: (ids) => Effect.orDie(unnamed(ids)),
      clearDetails: (endedBefore, at) => Effect.orDie(clearDetails(endedBefore, at)),
    });
  }),
);
