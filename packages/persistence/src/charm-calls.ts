import { CharmCalls } from "@hobbots/agents";
import { CharmCall } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { lockJournal } from "./journal.ts";

interface Row {
  readonly agentId: string;
  readonly callKey: string;
  readonly attempt: string;
  readonly tool: string;
  readonly input: string;
  readonly site: string;
  readonly plan: string;
  readonly state: string;
  readonly result: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly stepId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const decodeCall = Schema.decodeUnknownEffect(CharmCall);

const fromRow = (row: Row) =>
  decodeCall({
    agentId: row.agentId,
    key: row.callKey,
    attempt: row.attempt,
    tool: row.tool,
    input: row.input,
    site: row.site,
    plan: row.plan,
    state: row.state,
    result: row.result,
    threadId: row.threadId,
    messageId: row.messageId,
    stepId: row.stepId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.orDie);

const toRow = (call: CharmCall) => ({
  agent_id: call.agentId,
  call_key: call.key,
  attempt: call.attempt,
  tool: call.tool,
  input: call.input,
  site: call.site,
  plan: call.plan,
  state: call.state,
  result: call.result,
  thread_id: call.threadId,
  message_id: call.messageId,
  step_id: call.stepId,
  created_at: call.createdAt,
  updated_at: call.updatedAt,
});

const orDie = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is SqlError.SqlError => SqlError.isSqlError(error),
      (error) => Effect.die(error),
    ),
  );

/**
 * The SQL Charm call records (migration 0028). Recording a call checks its key and its site in the
 * same transaction, with the journal's head taken first so concurrent calls take turns on PostgreSQL.
 */
export const CharmCallsLive = Layer.effect(
  CharmCalls,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const one = (rows: ReadonlyArray<Row>) =>
      rows[0] === undefined ? Effect.succeed(Option.none<CharmCall>()) : fromRow(rows[0]).pipe(Effect.map(Option.some));
    const find = (agentId: string, key: string) =>
      sql<Row>`SELECT * FROM charm_calls WHERE agent_id = ${agentId} AND call_key = ${key}`.pipe(Effect.flatMap(one));

    return CharmCalls.of({
      begin: (call) =>
        Effect.gen(function* () {
          yield* lockJournal(sql);
          const stored = yield* find(call.agentId, call.key);
          const replaces =
            Option.isSome(stored) && stored.value.state === "not-sent" && stored.value.input === call.input;
          if (Option.isSome(stored) && !replaces) return { _tag: "Existing", call: stored.value } as const;
          const [busy] = yield* sql<Row>`
            SELECT * FROM charm_calls
            WHERE tool = ${call.tool} AND site = ${call.site} AND state IN ('sending', 'uncertain')
            ORDER BY created_at LIMIT 1`;
          if (busy !== undefined) return { _tag: "Blocked", call: yield* fromRow(busy) } as const;
          if (replaces) {
            yield* sql`DELETE FROM charm_calls WHERE agent_id = ${call.agentId} AND call_key = ${call.key}`;
          }
          yield* sql`INSERT INTO charm_calls ${sql.insert(toRow(call))}`;
          return { _tag: "Started" } as const;
        }).pipe(sql.withTransaction, orDie),
      // One conditional update, so of two outcomes racing for the same sending only the first lands,
      // and an outcome for an earlier sending of the key never lands on a later one.
      settle: (call, state, result, at) =>
        sql<Row>`
          UPDATE charm_calls SET state = ${state}, result = ${result}, updated_at = ${at}
          WHERE agent_id = ${call.agentId} AND call_key = ${call.key} AND attempt = ${call.attempt}
            AND state IN ('sending', 'uncertain')
          RETURNING *`.pipe(Effect.flatMap(one), orDie),
      find: (agentId, key) => orDie(find(agentId, key)),
      findByStep: (threadId, messageId, stepId) =>
        orDie(
          sql<Row>`
            SELECT * FROM charm_calls
            WHERE thread_id = ${threadId} AND message_id = ${messageId} AND step_id = ${stepId}
            ORDER BY created_at DESC LIMIT 1`.pipe(Effect.flatMap(one)),
        ),
      listForThread: (threadId) =>
        orDie(
          sql<Row>`SELECT * FROM charm_calls WHERE thread_id = ${threadId} ORDER BY created_at`.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
          ),
        ),
      unsettled: orDie(
        sql<Row>`SELECT * FROM charm_calls WHERE state IN ('sending', 'uncertain') ORDER BY created_at`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
        ),
      ),
    });
  }),
);
