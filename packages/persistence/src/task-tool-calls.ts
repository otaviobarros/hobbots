import { TaskToolCalls } from "@hobbots/agents";
import { type CarriedItem, TaskToolDone, TaskToolRefused } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { CurrentToolCall, makeDatabaseClock } from "./backpack-rows.ts";
import { lockJournal } from "./journal.ts";

const encodeDone = Schema.encodeSync(Schema.fromJsonString(TaskToolDone));
const decodeDone = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskToolDone));

/**
 * The SQL ledger of Task tool calls (migration 0025). A call's writes and its stored result commit
 * in one transaction; the journal's head is taken first, so a retry that arrives while the first
 * call is still writing waits for it and then returns its result. The calling turn's backpack
 * claims are checked next, in the same transaction, by one conditional update each (ADR 019).
 */
export const TaskToolCallsLive = Layer.effect(
  TaskToolCalls,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const clock = makeDatabaseClock(sql);

    /**
     * Refuses the call unless every claim the turn holds still holds: the item is at the turn's
     * token and is still claimed by it with its lease running by the database's clock, or the turn
     * settled it under that claim, as its own `complete_task` does. Updating the row in place keeps
     * an expiry off it until the call's transaction ends, so the claim checked is the one the call
     * commits under, on SQLite and PostgreSQL alike.
     */
    const fence = (claims: ReadonlyArray<CarriedItem>) =>
      Effect.forEach(
        claims.filter((claim) => claim.owner !== null),
        (claim) =>
          Effect.gen(function* () {
            const live = yield* sql`UPDATE backpack_items SET claim_token = claim_token
              WHERE id = ${claim.itemId} AND claim_token = ${claim.token}
                AND ((claim_owner = ${claim.owner} AND ${clock.leaseLive} AND state NOT IN ('resolved', 'failed'))
                  OR (claim_owner IS NULL AND state = 'resolved'))
              RETURNING id`;
            if (live.length > 0) return;
            return yield* new TaskToolRefused({
              reason: "claim-stale",
              message:
                `Your turn's claim on backpack item ${claim.itemId} ran out or passed to another turn, so this ` +
                "call did not happen and nothing was written. Stop here: Hobbots gives that work to a new turn.",
            });
          }),
        { discard: true },
      );

    return TaskToolCalls.of({
      once: (call, run) =>
        Effect.gen(function* () {
          yield* lockJournal(sql);
          // A stale turn is refused before anything else, a retried key included: it no longer holds its work.
          yield* fence(call.fence ?? []);
          const [stored] = yield* sql<{ readonly tool: string; readonly input: string; readonly result: string }>`
            SELECT tool, input, result FROM task_tool_calls
            WHERE agent_id = ${call.agentId} AND call_key = ${call.key}`;
          if (stored !== undefined) {
            if (stored.tool !== call.tool || stored.input !== call.input) {
              return yield* new TaskToolRefused({
                reason: "key-reused",
                message: `You already used the key ${call.key} for another call. Choose a new key for a new call.`,
              });
            }
            return { done: yield* Effect.orDie(decodeDone(stored.result)), entries: [] };
          }
          // The backpack items the call's writes record take their keys from the call's (ADR 019).
          const outcome = yield* run.pipe(
            Effect.provideService(CurrentToolCall, { agentId: call.agentId, key: call.key }),
          );
          yield* sql`INSERT INTO task_tool_calls ${sql.insert({
            agent_id: call.agentId,
            call_key: call.key,
            tool: call.tool,
            input: call.input,
            result: encodeDone(outcome.done),
            created_at: call.at,
          })}`;
          return outcome;
        }).pipe(
          sql.withTransaction,
          Effect.catchIf(
            (error): error is SqlError.SqlError => SqlError.isSqlError(error),
            (error) => Effect.die(error),
          ),
        ),
    });
  }),
);
