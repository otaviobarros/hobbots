import { DiagnosticsReads } from "@hobbots/agents";
import type { AttemptId, QuestId, TaskId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { journalForTasks } from "./journal.ts";
import { decodeRows, type Row } from "./task-rows.ts";

interface Latest {
  readonly attemptId: AttemptId;
  readonly at: string | null;
}

/** Diagnostics' own reads (ADR 026): the latest Quests, each Attempt's last progress and a Quest's journal. */
export const DiagnosticsReadsLive = Layer.effect(
  DiagnosticsReads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Newest first, byte by byte on both dialects, as `oldestFirst` orders the other way.
    const newestFirst = sql.onDialectOrElse({
      pg: () => sql.literal(`created_at COLLATE "C" DESC, id COLLATE "C" DESC`),
      orElse: () => sql.literal("created_at DESC, id DESC"),
    });

    const listQuests = (limit: number) =>
      sql<Row>`SELECT * FROM quests ORDER BY ${newestFirst} LIMIT ${limit}`.pipe(Effect.flatMap(decodeRows("quest")));

    const lastProgress = (attemptIds: ReadonlyArray<AttemptId>) =>
      Effect.gen(function* () {
        const latest = new Map<AttemptId, string>();
        if (attemptIds.length === 0) return latest;
        const keep = (rows: ReadonlyArray<Latest>) => {
          for (const row of rows) {
            const known = latest.get(row.attemptId);
            if (row.at !== null && (known === undefined || row.at > known)) latest.set(row.attemptId, row.at);
          }
        };
        const among = sql.in("attempt_id", attemptIds);
        keep(
          yield* sql<Latest>`SELECT attempt_id, MAX(created_at) AS at FROM checkpoints
          WHERE ${among} GROUP BY attempt_id`,
        );
        keep(
          yield* sql<Latest>`SELECT attempt_id, MAX(COALESCE(ended_at, started_at)) AS at FROM attempt_commands
          WHERE ${among} GROUP BY attempt_id`,
        );
        keep(
          yield* sql<Latest>`SELECT attempt_id, MAX(recorded_at) AS at FROM attempt_file_changes
          WHERE ${among} GROUP BY attempt_id`,
        );
        return latest;
      });

    // Each Task's chain of parents, nearest first, joined to the Quests that sit on them.
    const questsOf = (taskIds: ReadonlyArray<TaskId>) =>
      Effect.gen(function* () {
        const found = new Map<TaskId, QuestId>();
        if (taskIds.length === 0) return found;
        const rows = yield* sql<{
          readonly startId: TaskId;
          readonly questId: QuestId;
        }>`WITH RECURSIVE chain (start_id, id, parent_id, depth) AS (
            SELECT id, id, parent_id, 0 FROM tasks WHERE ${sql.in("id", taskIds)}
            UNION ALL
            SELECT chain.start_id, tasks.id, tasks.parent_id, chain.depth + 1
              FROM tasks JOIN chain ON tasks.id = chain.parent_id
          )
          SELECT chain.start_id AS start_id, quests.id AS quest_id FROM chain
            JOIN quests ON quests.task_id = chain.id
          ORDER BY chain.depth`;
        for (const row of rows) if (!found.has(row.startId)) found.set(row.startId, row.questId);
        return found;
      });

    // The migrator records each migration it applied by its number.
    const schemaVersion = sql<{ readonly id: unknown }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`.pipe(
      Effect.map(([row]) => Number(row?.id ?? 0)),
    );

    return DiagnosticsReads.of({
      listQuests: (limit) => listQuests(limit).pipe(Effect.orDie),
      lastProgress: (attemptIds) => lastProgress(attemptIds).pipe(Effect.orDie),
      questsOf: (taskIds) => questsOf(taskIds).pipe(Effect.orDie),
      journalForTasks: (taskIds, limit) => journalForTasks(sql, taskIds, limit).pipe(Effect.orDie),
      schemaVersion: schemaVersion.pipe(Effect.orDie),
      storage: Effect.succeed(sql.onDialectOrElse({ pg: () => "postgres" as const, orElse: () => "sqlite" as const })),
    });
  }),
);
