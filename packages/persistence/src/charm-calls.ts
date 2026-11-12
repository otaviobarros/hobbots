import { CharmCalls } from "@hobbots/agents";
import { CharmCall } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { lockJournal } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface Row {
  readonly agentId: string;
  readonly scope: string;
  readonly callKey: string;
  readonly attempt: string;
  readonly charm: string;
  readonly tool: string;
  readonly input: string;
  readonly site: string;
  readonly plan: string;
  readonly appliedText: string;
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
    scope: row.scope,
    key: row.callKey,
    attempt: row.attempt,
    charm: row.charm,
    tool: row.tool,
    input: row.input,
    site: row.site,
    plan: row.plan,
    appliedText: row.appliedText,
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
  scope: call.scope,
  call_key: call.key,
  attempt: call.attempt,
  charm: call.charm,
  tool: call.tool,
  input: call.input,
  site: call.site,
  plan: call.plan,
  applied_text: call.appliedText,
  state: call.state,
  result: call.result,
  thread_id: call.threadId,
  message_id: call.messageId,
  step_id: call.stepId,
  created_at: call.createdAt,
  updated_at: call.updatedAt,
});

/**
 * The SQL Charm call records (migrations 0028 and 0075), keyed by hob, scope and key (migration 0045). Recording a call checks its key and its site in the
 * same transaction, with the journal's head taken first so concurrent calls take turns on PostgreSQL.
 */
export const CharmCallsLive = Layer.effect(
  CharmCalls,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const one = (rows: ReadonlyArray<Row>) =>
      rows[0] === undefined ? Effect.succeed(Option.none<CharmCall>()) : fromRow(rows[0]).pipe(Effect.map(Option.some));
    const find = (agentId: string, scopes: ReadonlyArray<string>, key: string) =>
      sql<Row>`SELECT * FROM charm_calls
        WHERE agent_id = ${agentId} AND ${sql.in("scope", scopes)} AND call_key = ${key}
        ORDER BY created_at LIMIT 1`.pipe(Effect.flatMap(one));

    return CharmCalls.of({
      begin: (call, also) =>
        Effect.gen(function* () {
          yield* lockJournal(sql);
          const stored = yield* find(call.agentId, [call.scope, also ?? call.scope], call.key);
          const replaces =
            Option.isSome(stored) && stored.value.state === "not-sent" && stored.value.input === call.input;
          if (Option.isSome(stored) && !replaces) return { _tag: "Existing", call: stored.value } as const;
          const [busy] = yield* sql<Row>`
            SELECT * FROM charm_calls
            WHERE tool = ${call.tool} AND site = ${call.site} AND state IN ('sending', 'uncertain')
            ORDER BY created_at LIMIT 1`;
          if (busy !== undefined) return { _tag: "Blocked", call: yield* fromRow(busy) } as const;
          if (replaces) {
            yield* sql`DELETE FROM charm_calls
              WHERE agent_id = ${call.agentId} AND scope = ${stored.value.scope} AND call_key = ${call.key}`;
          }
          yield* sql`INSERT INTO charm_calls ${sql.insert(toRow(call))}`;
          return { _tag: "Started" } as const;
        }).pipe(sql.withTransaction, sqlOrDie),
      // One conditional update, so of two outcomes racing for the same sending only the first lands,
      // and an outcome for an earlier sending of the key never lands on a later one. By attempt, not
      // scope, so a sending still settles after its reply's calls moved to the Task it started (#660).
      settle: (call, state, result, at) =>
        sql<Row>`
          UPDATE charm_calls SET state = ${state}, result = ${result}, updated_at = ${at}
          WHERE agent_id = ${call.agentId} AND call_key = ${call.key} AND attempt = ${call.attempt}
            AND state IN ('sending', 'uncertain')
          RETURNING *`.pipe(Effect.flatMap(one), sqlOrDie),
      find: (agentId, scopes, key) => sqlOrDie(find(agentId, scopes, key)),
      current: (call) =>
        sqlOrDie(
          sql<Row>`SELECT * FROM charm_calls
            WHERE agent_id = ${call.agentId} AND call_key = ${call.key} AND attempt = ${call.attempt}`.pipe(
            Effect.flatMap(one),
          ),
        ),
      findByStep: (threadId, messageId, stepId) =>
        sqlOrDie(
          sql<Row>`
            SELECT * FROM charm_calls
            WHERE thread_id = ${threadId} AND message_id = ${messageId} AND step_id = ${stepId}
            ORDER BY created_at DESC LIMIT 1`.pipe(Effect.flatMap(one)),
        ),
      listForThread: (threadId) =>
        sqlOrDie(
          sql<Row>`SELECT * FROM charm_calls WHERE thread_id = ${threadId} ORDER BY created_at`.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
          ),
        ),
      findSending: (scope, attempt) =>
        sqlOrDie(
          sql<Row>`SELECT * FROM charm_calls WHERE scope = ${scope} AND attempt = ${attempt}`.pipe(Effect.flatMap(one)),
        ),
      // A Task's session records no reply: its calls have no message, and their work is a Task.
      uncertainOnTasks: sqlOrDie(
        sql<Row>`SELECT * FROM charm_calls
          WHERE state = 'uncertain' AND message_id IS NULL AND scope LIKE 'task:%'
          ORDER BY created_at`.pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow))),
      ),
      unsettled: sqlOrDie(
        sql<Row>`SELECT * FROM charm_calls WHERE state IN ('sending', 'uncertain') ORDER BY created_at`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
        ),
      ),
    });
  }),
);
