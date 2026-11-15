import {
  type Actor,
  type AnswerOwed,
  type Line,
  type Message,
  type MessageId,
  relayStateFor,
  type ChannelId,
  TurnRequest,
  type TurnRequestEvent,
  TurnRequestId,
  TurnRequests,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

// The answers hobs owe each conversation (ADR 039, One hob speaks at a time; migration
// 20261114003401). An actor is two columns, as a message's author is; PostgreSQL reads BIGINT as a
// bigint and SQLite as a number. Requests are not journaled, an exception to STD-ARCH-015 that
// ADR 039's amendment records: clients see the floor through the channel's run.

interface TurnRequestRow {
  readonly id: unknown;
  readonly channelId: unknown;
  readonly rootMessageId: unknown;
  readonly hobId: unknown;
  readonly messageId: unknown;
  readonly causedByKind: unknown;
  readonly causedById: unknown;
  readonly cause: unknown;
  readonly relayDepth: unknown;
  readonly state: unknown;
  readonly replyId: unknown;
  readonly droppedByKind: unknown;
  readonly droppedById: unknown;
  readonly passReason: unknown;
  readonly queuedAt: unknown;
  readonly position: unknown;
  readonly createdAt: unknown;
}

const decodeRequest = Schema.decodeUnknownEffect(TurnRequest);

/** Rows as requests, in their order. A row the schema refuses is a defect: the database checks them. */
const requestsFromRows = (rows: ReadonlyArray<TurnRequestRow>) =>
  Effect.forEach(rows, (row) =>
    decodeRequest({
      id: row.id,
      channelId: row.channelId,
      rootMessageId: row.rootMessageId ?? null,
      hobId: row.hobId,
      messageId: row.messageId,
      causedBy: { kind: row.causedByKind, id: row.causedById },
      cause: row.cause,
      relayDepth: Number(row.relayDepth),
      state: row.state,
      replyId: row.replyId ?? null,
      droppedBy: row.droppedByKind == null ? null : { kind: row.droppedByKind, id: row.droppedById },
      passReason: row.passReason ?? null,
      queuedAt: Number(row.queuedAt),
      position: Number(row.position),
      createdAt: row.createdAt,
    }).pipe(Effect.orDie),
  );

const OPEN = ["waiting", "paused", "speaking"] as const;

/** The requests still owed in a line, in floor order. */
export const selectOpenRequests = (sql: SqlClient.SqlClient, line: Line) =>
  sql<TurnRequestRow>`SELECT * FROM turn_requests
    WHERE channel_id = ${line.channelId}
      AND ${line.rootMessageId === null ? sql`root_message_id IS NULL` : sql`root_message_id = ${line.rootMessageId}`}
      AND ${sql.in("state", OPEN)}
    ORDER BY queued_at, position`.pipe(Effect.flatMap(requestsFromRows));

/** The requests `hobId` waits to answer in the channel, on any line, paused ones included. */
export const selectWaitingOf = (sql: SqlClient.SqlClient, channelId: ChannelId, hobId: string) =>
  sql<TurnRequestRow>`SELECT * FROM turn_requests
    WHERE channel_id = ${channelId} AND hob_id = ${hobId} AND ${sql.in("state", ["waiting", "paused"])}
    ORDER BY queued_at, position`.pipe(Effect.flatMap(requestsFromRows));

/** Every request in `state`, across channels, in floor order. */
export const selectRequestsIn = (sql: SqlClient.SqlClient, state: TurnRequest["state"]) =>
  sql<TurnRequestRow>`SELECT * FROM turn_requests WHERE state = ${state}
    ORDER BY queued_at, position`.pipe(Effect.flatMap(requestsFromRows));

/** The requests still owed for these messages, or that these replies speak for. */
export const selectOpenRequestsOf = (
  sql: SqlClient.SqlClient,
  column: "message_id" | "reply_id",
  ids: ReadonlyArray<MessageId>,
): Effect.Effect<ReadonlyArray<TurnRequest>, SqlError.SqlError> =>
  ids.length === 0
    ? Effect.succeed<ReadonlyArray<TurnRequest>>([])
    : sql<TurnRequestRow>`SELECT * FROM turn_requests WHERE ${sql.in(column, ids)} AND ${sql.in("state", OPEN)}
        ORDER BY queued_at, position`.pipe(Effect.flatMap(requestsFromRows));

export const selectRequestsById = (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<TurnRequestId>,
): Effect.Effect<ReadonlyArray<TurnRequest>, SqlError.SqlError> =>
  ids.length === 0
    ? Effect.succeed<ReadonlyArray<TurnRequest>>([])
    : sql<TurnRequestRow>`SELECT * FROM turn_requests WHERE ${sql.in("id", ids)}
        ORDER BY queued_at, position`.pipe(Effect.flatMap(requestsFromRows));

/**
 * The requests `message` causes, one per hob that owes it an answer, in the order given. A person's
 * message starts the relay count; a hob's mention adds one to its own turn's depth (`relayDepth`),
 * and one past the relay budget is written `paused` (ADR 039, Hobs talking to hobs).
 */
export const requestsFor = (
  message: Message,
  causedBy: Actor,
  answerers: ReadonlyArray<AnswerOwed>,
  relayDepth: number,
): ReadonlyArray<TurnRequest> =>
  answerers.map(
    (answerer, position) =>
      new TurnRequest({
        id: TurnRequestId.make(crypto.randomUUID()),
        channelId: message.channelId,
        rootMessageId: null,
        hobId: answerer.hobId,
        messageId: message.id,
        causedBy,
        cause: answerer.cause,
        relayDepth,
        state: relayStateFor(relayDepth),
        replyId: null,
        droppedBy: null,
        queuedAt: message.revision,
        position,
        createdAt: message.createdAt,
      }),
  );

export const insertRequest = (sql: SqlClient.SqlClient, request: TurnRequest) =>
  sql`INSERT INTO turn_requests ${sql.insert({
    id: request.id,
    channel_id: request.channelId,
    root_message_id: request.rootMessageId,
    hob_id: request.hobId,
    message_id: request.messageId,
    caused_by_kind: request.causedBy.kind,
    caused_by_id: request.causedBy.id,
    cause: request.cause,
    relay_depth: request.relayDepth,
    state: request.state,
    reply_id: request.replyId,
    dropped_by_kind: request.droppedBy?.kind ?? null,
    dropped_by_id: request.droppedBy?.id ?? null,
    pass_reason: request.passReason,
    queued_at: request.queuedAt,
    position: request.position,
    created_at: request.createdAt,
  })}`;

/**
 * Moves each request through `TurnRequestMachine` with `event` and saves those it allows, so only
 * the machine changes a request's state. Returns the requests it changed, as saved.
 */
export const stepRequests = (sql: SqlClient.SqlClient, requests: ReadonlyArray<TurnRequest>, event: TurnRequestEvent) =>
  Effect.forEach(requests, (request) => {
    const next = TurnRequests.transition(request, event);
    if (!(next instanceof TurnRequest)) return Effect.succeed<ReadonlyArray<TurnRequest>>([]);
    return sql`UPDATE turn_requests SET state = ${next.state}, reply_id = ${next.replyId}, relay_depth = ${next.relayDepth},
        dropped_by_kind = ${next.droppedBy?.kind ?? null}, dropped_by_id = ${next.droppedBy?.id ?? null},
        pass_reason = ${next.passReason}
      WHERE id = ${next.id} AND state = ${request.state}`.pipe(Effect.as([next]));
  }).pipe(Effect.map((changed) => changed.flat()));

/** Every request the turn writing `replyId` spoke for, or that its reply caused, in any state. */
export const selectRequestsOfReply = (sql: SqlClient.SqlClient, replyId: MessageId) =>
  sql<TurnRequestRow>`SELECT * FROM turn_requests WHERE reply_id = ${replyId} OR message_id = ${replyId}
    ORDER BY queued_at, position`.pipe(Effect.flatMap(requestsFromRows));

/** The channels with a request waiting there, or paused past the relay budget. */
export const selectChannelsWaiting = (sql: SqlClient.SqlClient) =>
  sql<{ readonly channelId: string }>`SELECT DISTINCT channel_id FROM turn_requests
    WHERE state IN ('waiting', 'paused')`.pipe(Effect.map((rows) => rows.map((row) => row.channelId as ChannelId)));
