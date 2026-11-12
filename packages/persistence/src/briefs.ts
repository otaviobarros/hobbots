import { BriefLog } from "@hobbots/agents";
import {
  type ActorKind,
  Brief,
  type BriefDraft,
  type BriefSource,
  briefChange,
  briefSourceOf,
  HUB_ACTOR,
  type JournaledEvent,
  type TaskId,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { EventJournal, makeJournaledChange } from "./journal.ts";
import { moveProjectorCursor, projectorCursor } from "./projector-cursors.ts";
import { sqlOrDie } from "./sql-errors.ts";

// Camp briefs and the brief projector's cursor (migration 0102, #1384). A draft is written only when
// `briefChange` lets it through, against the brief as it stands inside the transaction, and is
// journaled as `BriefWritten` in the transaction that moves the cursor; so a replayed page, or two
// rounds at once, never write a brief twice.

const PROJECTOR = "camp-briefs";

interface BriefRow {
  readonly threadId: string;
  readonly text: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly source: string;
  readonly basis: unknown;
  readonly writtenAt: string;
  readonly revision: unknown;
}

const briefOfRow = (row: BriefRow) =>
  new Brief({
    threadId: ThreadId.make(row.threadId),
    text: row.text,
    writtenBy: { kind: row.actorKind as ActorKind, id: row.actorId },
    source: row.source as BriefSource,
    basis: Number(row.basis),
    writtenAt: row.writtenAt,
    revision: Number(row.revision),
  });

export const BriefLogLive = Layer.effect(
  BriefLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;
    const journaledChange = makeJournaledChange(sql);

    const stored = (threadId: ThreadId) =>
      sql<BriefRow>`SELECT * FROM briefs WHERE thread_id = ${threadId}`.pipe(
        Effect.map(([row]) => (row === undefined ? null : briefOfRow(row))),
      );

    const threadsOfTasks = (taskIds: ReadonlyArray<TaskId>) =>
      taskIds.length === 0
        ? Effect.succeed([])
        : sql<{ readonly threadId: string }>`SELECT DISTINCT thread_id FROM tasks
            WHERE ${sql.in("id", taskIds)} AND thread_id IS NOT NULL`.pipe(
            Effect.map((rows) => rows.map((row) => ThreadId.make(row.threadId))),
          );

    // The brief the draft writes, or null when its rule lets nothing through.
    const written = (draft: BriefDraft, at: string, revision: number) =>
      Effect.gen(function* () {
        // A thread that is not there takes no brief.
        const [thread] = yield* sql`SELECT 1 FROM threads WHERE id = ${draft.threadId}`;
        if (thread === undefined) return null;
        if (briefChange(yield* stored(draft.threadId), draft) !== "write") return null;
        const brief = new Brief({
          threadId: draft.threadId,
          text: draft.text,
          writtenBy: HUB_ACTOR,
          source: briefSourceOf(draft),
          basis: draft.basis,
          writtenAt: at,
          revision,
        });
        const row = {
          thread_id: brief.threadId,
          text: brief.text,
          actor_kind: brief.writtenBy.kind,
          actor_id: brief.writtenBy.id,
          source: brief.source,
          basis: brief.basis,
          written_at: brief.writtenAt,
          revision: brief.revision,
        };
        yield* sql`INSERT INTO briefs ${sql.insert(row)}
          ON CONFLICT (thread_id) DO UPDATE SET text = ${row.text}, actor_kind = ${row.actor_kind},
            actor_id = ${row.actor_id}, source = ${row.source}, basis = ${row.basis},
            written_at = ${row.written_at}, revision = ${row.revision}`;
        return brief;
      });

    const record = (sequence: number, drafts: ReadonlyArray<BriefDraft>, at: string) =>
      journaledChange<void, never>((first) =>
        Effect.gen(function* () {
          const events: Array<JournaledEvent> = [];
          for (const draft of drafts) {
            const brief = yield* written(draft, at, first + events.length);
            if (brief !== null) events.push({ _tag: "BriefWritten", brief });
          }
          yield* moveProjectorCursor(sql, PROJECTOR, sequence);
          return { value: undefined, events };
        }),
      ).pipe(Effect.map((committed) => committed.entries));

    return BriefLog.of({
      cursor: sqlOrDie(projectorCursor(sql, PROJECTOR)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      threadsOfTasks: (taskIds) => sqlOrDie(threadsOfTasks(taskIds)),
      briefOf: (threadId) => sqlOrDie(stored(threadId)).pipe(Effect.map(Option.fromNullishOr)),
      record,
    });
  }),
);
