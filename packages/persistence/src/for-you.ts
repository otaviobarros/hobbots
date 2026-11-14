import { ForYouRepository } from "@hobbots/agents";
import type { Actor, AwayMessage, MessageId, ThreadId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { type ArtifactRow, artifactsFromRows } from "./artifact-rows.ts";
import { mentionsActor } from "./message-mentions.ts";
import { threadQuests } from "./notes.ts";
import { byteOrder } from "./order.ts";
import { type DecisionRow, decisionFromRow } from "./records.ts";
import { sqlOrDie } from "./sql-errors.ts";

// For you (ADR 039, #1456): the records past each of one person's read markers, read in a few
// queries across every thread they are an active member of, for the pure `forYouOf` to fold.

interface MentionRow {
  readonly id: string;
  readonly threadId: string;
  readonly role: AwayMessage["role"];
  readonly status: AwayMessage["status"];
  readonly content: string;
  readonly quiet: unknown;
  readonly revision: unknown;
  readonly createdAt: string;
  readonly actorKind: Actor["kind"] | null;
  readonly actorId: string | null;
  readonly mentions: string;
}

const awayMessage = (row: MentionRow): AwayMessage => ({
  id: row.id as MessageId,
  role: row.role,
  status: row.status,
  content: row.content,
  quiet: Number(row.quiet ?? 0) === 1,
  revision: Number(row.revision),
  createdAt: row.createdAt,
  actor: row.actorKind === null || row.actorId === null ? null : { kind: row.actorKind, id: row.actorId },
  mentions: JSON.parse(row.mentions),
});

/** Groups rows by their thread. */
const byThread = <A extends { readonly threadId: ThreadId }>(rows: ReadonlyArray<A>) => {
  const grouped = new Map<ThreadId, Array<A>>();
  for (const row of rows) grouped.set(row.threadId, [...(grouped.get(row.threadId) ?? []), row]);
  return grouped;
};

export const ForYouRepositoryLive = Layer.effect(
  ForYouRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Joins a record's thread to the person's active member row, and keeps it past their marker.
    const pastMarker = (actor: Actor, alias: string) =>
      sql`JOIN thread_members tm ON tm.thread_id = ${sql.literal(alias)}.thread_id
        AND tm.actor_kind = ${actor.kind} AND tm.actor_id = ${actor.id} AND tm.state = 'active'
        WHERE ${sql.literal(alias)}.revision > COALESCE(tm.read_revision, 0)`;

    const threads = (actor: Actor) =>
      Effect.gen(function* () {
        const members = yield* sql<{ readonly threadId: ThreadId; readonly readRevision: unknown }>`SELECT thread_id,
          read_revision FROM thread_members
          WHERE actor_kind = ${actor.kind} AND actor_id = ${actor.id} AND state = 'active'
          ORDER BY ${byteOrder(sql, ["thread_id"])}`;
        const mentioning = byThread(
          (yield* sql<MentionRow>`SELECT m.id, m.thread_id, m.role, m.status, m.content, m.quiet, m.revision,
            m.created_at, m.actor_kind, m.actor_id, m.mentions FROM messages m ${pastMarker(actor, "m")}
            AND ${mentionsActor(sql, actor)}
            ORDER BY m.revision`).map((row) => ({ ...awayMessage(row), threadId: row.threadId as ThreadId })),
        );
        const decisions = byThread(
          yield* Effect.flatMap(
            sql<DecisionRow>`SELECT d.* FROM decisions d ${pastMarker(actor, "d")} ORDER BY d.recorded_sequence DESC`,
            (rows) => Effect.forEach(rows, decisionFromRow),
          ),
        );
        const artifacts = byThread(
          yield* Effect.flatMap(
            sql<ArtifactRow>`SELECT a.* FROM artifacts a ${pastMarker(actor, "a")}
              ORDER BY a.updated_at DESC, a.revision DESC`,
            artifactsFromRows,
          ),
        );
        const questThreads = new Set(
          (yield* sql<{ readonly threadId: ThreadId }>`SELECT DISTINCT s.thread_id FROM quest_summaries s
            ${pastMarker(actor, "s")}`).map((row) => row.threadId),
        );
        return yield* Effect.forEach(members, (member) =>
          Effect.gen(function* () {
            const { threadId } = member;
            return {
              threadId,
              marker: member.readRevision == null ? null : Number(member.readRevision),
              messages: mentioning.get(threadId) ?? [],
              decisions: decisions.get(threadId) ?? [],
              artifacts: artifacts.get(threadId) ?? [],
              quests: questThreads.has(threadId) ? yield* threadQuests(sql, threadId) : [],
            };
          }),
        );
      });

    const owners = Effect.map(
      sql<{ readonly threadId: ThreadId; readonly actorKind: Actor["kind"]; readonly actorId: string }>`SELECT
        thread_id, actor_kind, actor_id FROM thread_members WHERE role = 'owner'`,
      (rows) => new Map(rows.map((row) => [row.threadId, { kind: row.actorKind, id: row.actorId }] as const)),
    );

    const waitingReviews = Effect.flatMap(
      sql<ArtifactRow>`SELECT * FROM artifacts WHERE review = 'waiting' ORDER BY ${byteOrder(sql, ["updated_at", "id"])}`,
      artifactsFromRows,
    );

    return ForYouRepository.of({
      threads: (actor) => sqlOrDie(threads(actor)),
      owners: sqlOrDie(owners),
      waitingReviews: sqlOrDie(waitingReviews),
    });
  }),
);
