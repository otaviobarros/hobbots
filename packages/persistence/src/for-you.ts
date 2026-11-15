import { ForYouRepository } from "@hobbots/agents";
import type { Actor, AwayMessage, ChannelId, MessageId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { type ArtifactRow, artifactsFromRows } from "./artifact-rows.ts";
import { mentionsActor } from "./message-mentions.ts";
import { channelQuests } from "./notes.ts";
import { byteOrder } from "./order.ts";
import { type DecisionRow, decisionFromRow } from "./records.ts";
import { sqlOrDie } from "./sql-errors.ts";

// For you (ADR 039, #1456): the records past each of one person's read markers, read in a few
// queries across every channel they are an active member of, for the pure `forYouOf` to fold.

interface MentionRow {
  readonly id: string;
  readonly channelId: string;
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

/** Groups rows by their channel. */
const byChannel = <A extends { readonly channelId: ChannelId }>(rows: ReadonlyArray<A>) => {
  const grouped = new Map<ChannelId, Array<A>>();
  for (const row of rows) grouped.set(row.channelId, [...(grouped.get(row.channelId) ?? []), row]);
  return grouped;
};

export const ForYouRepositoryLive = Layer.effect(
  ForYouRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Joins a record's channel to the person's active member row, and keeps it past their marker.
    const pastMarker = (actor: Actor, alias: string) =>
      sql`JOIN channel_members tm ON tm.channel_id = ${sql.literal(alias)}.channel_id
        AND tm.actor_kind = ${actor.kind} AND tm.actor_id = ${actor.id} AND tm.state = 'active'
        WHERE ${sql.literal(alias)}.revision > COALESCE(tm.read_revision, 0)`;

    const channels = (actor: Actor) =>
      Effect.gen(function* () {
        const members = yield* sql<{ readonly channelId: ChannelId; readonly readRevision: unknown }>`SELECT channel_id,
          read_revision FROM channel_members
          WHERE actor_kind = ${actor.kind} AND actor_id = ${actor.id} AND state = 'active'
          ORDER BY ${byteOrder(sql, ["channel_id"])}`;
        const mentioning = byChannel(
          (yield* sql<MentionRow>`SELECT m.id, m.channel_id, m.role, m.status, m.content, m.quiet, m.revision,
            m.created_at, m.actor_kind, m.actor_id, m.mentions FROM messages m ${pastMarker(actor, "m")}
            AND ${mentionsActor(sql, actor)}
            ORDER BY m.revision`).map((row) => ({ ...awayMessage(row), channelId: row.channelId as ChannelId })),
        );
        const decisions = byChannel(
          yield* Effect.flatMap(
            sql<DecisionRow>`SELECT d.* FROM decisions d ${pastMarker(actor, "d")} ORDER BY d.recorded_sequence DESC`,
            (rows) => Effect.forEach(rows, decisionFromRow),
          ),
        );
        const artifacts = byChannel(
          yield* Effect.flatMap(
            sql<ArtifactRow>`SELECT a.* FROM artifacts a ${pastMarker(actor, "a")}
              ORDER BY a.updated_at DESC, a.revision DESC`,
            artifactsFromRows,
          ),
        );
        const questChannels = new Set(
          (yield* sql<{ readonly channelId: ChannelId }>`SELECT DISTINCT s.channel_id FROM quest_summaries s
            ${pastMarker(actor, "s")}`).map((row) => row.channelId),
        );
        return yield* Effect.forEach(members, (member) =>
          Effect.gen(function* () {
            const { channelId } = member;
            return {
              channelId,
              marker: member.readRevision == null ? null : Number(member.readRevision),
              messages: mentioning.get(channelId) ?? [],
              decisions: decisions.get(channelId) ?? [],
              artifacts: artifacts.get(channelId) ?? [],
              quests: questChannels.has(channelId) ? yield* channelQuests(sql, channelId) : [],
            };
          }),
        );
      });

    const owners = Effect.map(
      sql<{ readonly channelId: ChannelId; readonly actorKind: Actor["kind"]; readonly actorId: string }>`SELECT
        channel_id, actor_kind, actor_id FROM channel_members WHERE role = 'owner'`,
      (rows) => new Map(rows.map((row) => [row.channelId, { kind: row.actorKind, id: row.actorId }] as const)),
    );

    const waitingReviews = Effect.flatMap(
      sql<ArtifactRow>`SELECT * FROM artifacts WHERE review = 'waiting' ORDER BY ${byteOrder(sql, ["updated_at", "id"])}`,
      artifactsFromRows,
    );

    return ForYouRepository.of({
      channels: (actor) => sqlOrDie(channels(actor)),
      owners: sqlOrDie(owners),
      waitingReviews: sqlOrDie(waitingReviews),
    });
  }),
);
