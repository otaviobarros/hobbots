import { type WorkQuestFinishRequest, WorkQuestRepository, type WorkQuestStart } from "@hobbots/agents";
import { ChannelNotFound } from "@hobbots/api";
import {
  type Actor,
  type ChannelId,
  hobActor,
  type JournaledEvent,
  type MessageId,
  planWorkQuestFinish,
  planWorkQuestStart,
  WorkQuestRefused as Refused,
  WorkQuest,
  type WorkQuestRefused,
  WorkQuests,
} from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";

// Quests as work threads (ADR 041, migration 20261116004540_work_quests). The rules are the pure
// `planWorkQuestStart` and `planWorkQuestFinish` in @hobbots/domain; this runs them on the Quests as
// stored, in the transaction that writes their result and journals its event, after taking the
// journal's head, so two starts in one conversation cannot both pass the check.

/** A row of `work_quests`, as the SQL client reads it. */
interface WorkQuestRow {
  readonly id: string;
  readonly channelId: string;
  readonly rootMessageId: string | null;
  readonly title: string;
  readonly goal: string;
  readonly doneWhen: string;
  readonly expectedBy: string | null;
  readonly ownerHobId: string;
  readonly requestedByKind: string;
  readonly requestedById: string;
  readonly repository: string | null;
  readonly startedFrom: string;
  readonly state: string;
  readonly result: string | null;
  readonly made: string;
  readonly finishedFrom: string | null;
  readonly createdAt: string;
  readonly changedAt: string;
  readonly revision: number | string;
}

const decode = Schema.decodeUnknownEffect(WorkQuest);

/** A stored Quest; a row that does not decode is a defect, since the hub wrote it. */
const questFromRow = (row: WorkQuestRow) =>
  decode({
    id: row.id,
    channelId: row.channelId,
    rootMessageId: row.rootMessageId,
    title: row.title,
    goal: row.goal,
    doneWhen: JSON.parse(row.doneWhen),
    expectedBy: row.expectedBy,
    ownerHobId: row.ownerHobId,
    requestedBy: { kind: row.requestedByKind, id: row.requestedById },
    repository: row.repository,
    startedFrom: row.startedFrom,
    state: row.state,
    result: row.result,
    made: JSON.parse(row.made),
    finishedFrom: row.finishedFrom,
    createdAt: row.createdAt,
    changedAt: row.changedAt,
    // PostgreSQL reads BIGINT as a bigint; every revision fits a number.
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

/** A Quest at the revision of the event that journals it. */
const at = (quest: WorkQuest, revision: number) => new WorkQuest({ ...quest, revision });

const unchanged = (quest: WorkQuest) => ({ value: quest, events: [] as ReadonlyArray<JournaledEvent> });

export const WorkQuestRepositoryLive = Layer.effect(
  WorkQuestRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);

    const findBy = (column: "started_from" | "finished_from", messageId: MessageId) =>
      Effect.gen(function* () {
        const [row] = yield* sql<WorkQuestRow>`SELECT * FROM work_quests WHERE ${sql(column)} = ${messageId}`;
        return row === undefined ? null : yield* questFromRow(row);
      });

    /** The Quest the conversation runs, active or waiting, if any (ADR 041: at most one). */
    const runningIn = (channelId: ChannelId, rootMessageId: MessageId | null) =>
      Effect.gen(function* () {
        const rows = yield* sql<WorkQuestRow>`SELECT * FROM work_quests
          WHERE channel_id = ${channelId} AND COALESCE(root_message_id, '') = ${rootMessageId ?? ""}
          AND state IN ('active', 'waiting')`;
        const quests = yield* Effect.forEach(rows, questFromRow);
        return quests.find(WorkQuests.isRunning) ?? null;
      });

    /**
     * Who asked for the work: the author of the message whose turn request the reply answers, or
     * the hob itself when no request names the reply, as for a turn it continued on its own.
     */
    const requesterOf = (replyId: MessageId, owner: WorkQuestStart["ownerHobId"]) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ readonly causedByKind: string; readonly causedById: string }>`
          SELECT caused_by_kind, caused_by_id FROM turn_requests WHERE reply_id = ${replyId}
          ORDER BY queued_at, position LIMIT 1`;
        return row === undefined ? hobActor(owner) : ({ kind: row.causedByKind, id: row.causedById } as Actor);
      });

    const start = (request: WorkQuestStart) =>
      change<WorkQuest, WorkQuestRefused | ChannelNotFound>((first) =>
        Effect.gen(function* () {
          const earlier = yield* findBy("started_from", request.startedFrom);
          // A retried call returns the Quest it started; another start from the same reply is refused.
          if (earlier !== null && earlier.title === request.title.trim()) return unchanged(earlier);
          if (earlier !== null) {
            return yield* new Refused({
              reason: "busy",
              message: `This reply already started the Quest "${earlier.title}" (${earlier.id}). A conversation runs one Quest at a time.`,
            });
          }
          const [channel] = yield* sql<{
            readonly state: string;
          }>`SELECT state FROM channels WHERE id = ${request.channelId}`;
          if (channel === undefined) return yield* new ChannelNotFound({ channelId: request.channelId });
          const planned = planWorkQuestStart({
            ...request,
            requestedBy: yield* requesterOf(request.startedFrom, request.ownerHobId),
            channelOpen: channel.state === "open",
            running: yield* runningIn(request.channelId, request.rootMessageId),
          });
          if (planned instanceof Refused) return yield* planned;
          const quest = at(planned, first);
          yield* sql`INSERT INTO work_quests ${sql.insert({
            id: quest.id,
            channel_id: quest.channelId,
            root_message_id: quest.rootMessageId,
            title: quest.title,
            goal: quest.goal,
            done_when: JSON.stringify(quest.doneWhen),
            expected_by: quest.expectedBy,
            owner_hob_id: quest.ownerHobId,
            requested_by_kind: quest.requestedBy.kind,
            requested_by_id: quest.requestedBy.id,
            repository: quest.repository,
            started_from: quest.startedFrom,
            state: quest.state,
            result: quest.result,
            made: JSON.stringify(quest.made),
            finished_from: quest.finishedFrom,
            created_at: quest.createdAt,
            changed_at: quest.changedAt,
            revision: quest.revision,
          })}`;
          return { value: quest, events: [{ _tag: "WorkQuestStarted" as const, workQuest: quest }] };
        }),
      );

    const finish = (request: WorkQuestFinishRequest) =>
      change<WorkQuest, WorkQuestRefused>((first) =>
        Effect.gen(function* () {
          const earlier = yield* findBy("finished_from", request.from);
          if (earlier !== null) return unchanged(earlier);
          const running = yield* runningIn(request.channelId, request.rootMessageId);
          // Only its owner finishes a Quest: another hob's is not the caller's to finish.
          const own = running !== null && running.ownerHobId === request.ownerHobId ? running : null;
          const planned = planWorkQuestFinish(own, request);
          if (planned instanceof Refused) return yield* planned;
          const quest = at(planned, first);
          yield* sql`UPDATE work_quests SET state = ${quest.state}, result = ${quest.result},
            made = ${JSON.stringify(quest.made)}, finished_from = ${quest.finishedFrom},
            changed_at = ${quest.changedAt}, revision = ${quest.revision} WHERE id = ${quest.id}`;
          return { value: quest, events: [{ _tag: "WorkQuestChanged" as const, workQuest: quest }] };
        }),
      );

    const list = (channelId: ChannelId) =>
      Effect.gen(function* () {
        const [channel] = yield* sql`SELECT id FROM channels WHERE id = ${channelId}`.pipe(Effect.orDie);
        if (channel === undefined) return yield* new ChannelNotFound({ channelId });
        const rows =
          yield* sql<WorkQuestRow>`SELECT * FROM work_quests WHERE channel_id = ${channelId} ORDER BY created_at, id`;
        return yield* Effect.forEach(rows, questFromRow);
      }).pipe(Effect.catchTag("SqlError", Effect.die));

    return WorkQuestRepository.of({ start, finish, list });
  }),
);
