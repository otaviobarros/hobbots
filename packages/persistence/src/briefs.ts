import { BriefLog } from "@hobbots/agents";
import {
  type ActorKind,
  Brief,
  type BriefDraft,
  type BriefSource,
  briefChange,
  briefSourceOf,
  ChannelId,
  HUB_ACTOR,
  type JournaledEvent,
  type TaskId,
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
  readonly channelId: string;
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
    channelId: ChannelId.make(row.channelId),
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

    const stored = (channelId: ChannelId) =>
      sql<BriefRow>`SELECT * FROM briefs WHERE channel_id = ${channelId}`.pipe(
        Effect.map(([row]) => (row === undefined ? null : briefOfRow(row))),
      );

    const channelsOfTasks = (taskIds: ReadonlyArray<TaskId>) =>
      taskIds.length === 0
        ? Effect.succeed([])
        : sql<{ readonly channelId: string }>`SELECT DISTINCT channel_id FROM tasks
            WHERE ${sql.in("id", taskIds)} AND channel_id IS NOT NULL`.pipe(
            Effect.map((rows) => rows.map((row) => ChannelId.make(row.channelId))),
          );

    // The brief the draft writes, or null when its rule lets nothing through.
    const written = (draft: BriefDraft, at: string, revision: number) =>
      Effect.gen(function* () {
        // A channel that is not there takes no brief.
        const [channel] = yield* sql`SELECT 1 FROM channels WHERE id = ${draft.channelId}`;
        if (channel === undefined) return null;
        if (briefChange(yield* stored(draft.channelId), draft) !== "write") return null;
        const brief = new Brief({
          channelId: draft.channelId,
          text: draft.text,
          writtenBy: HUB_ACTOR,
          source: briefSourceOf(draft),
          basis: draft.basis,
          writtenAt: at,
          revision,
        });
        const row = {
          channel_id: brief.channelId,
          text: brief.text,
          actor_kind: brief.writtenBy.kind,
          actor_id: brief.writtenBy.id,
          source: brief.source,
          basis: brief.basis,
          written_at: brief.writtenAt,
          revision: brief.revision,
        };
        yield* sql`INSERT INTO briefs ${sql.insert(row)}
          ON CONFLICT (channel_id) DO UPDATE SET text = ${row.text}, actor_kind = ${row.actor_kind},
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
      channelsOfTasks: (taskIds) => sqlOrDie(channelsOfTasks(taskIds)),
      briefOf: (channelId) => sqlOrDie(stored(channelId)).pipe(Effect.map(Option.fromNullishOr)),
      record,
    });
  }),
);
