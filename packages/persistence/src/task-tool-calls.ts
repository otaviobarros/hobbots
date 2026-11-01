import { TaskToolCalls } from "@hobbots/agents";
import { TaskToolDone, TaskToolRefused } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { CurrentToolCall } from "./backpack-rows.ts";
import { lockJournal } from "./journal.ts";

const encodeDone = Schema.encodeSync(Schema.fromJsonString(TaskToolDone));
const decodeDone = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskToolDone));

/**
 * The SQL ledger of Task tool calls (migration 0025). A call's writes and its stored result commit
 * in one transaction; the journal's head is taken first, so a retry that arrives while the first
 * call is still writing waits for it and then returns its result.
 */
export const TaskToolCallsLive = Layer.effect(
  TaskToolCalls,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return TaskToolCalls.of({
      once: (call, run) =>
        Effect.gen(function* () {
          yield* lockJournal(sql);
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
