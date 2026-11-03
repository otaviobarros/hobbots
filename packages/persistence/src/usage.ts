import { AgentId, AgentStatus, type HobUsage, type HourUsage, RuntimeKind } from "@hobbots/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

// What hobs' replies used (OP-002), summed in SQL from the usage columns of migration 0037 and the
// runtime and model of migration 0020. Only settled replies count: one still streaming has not
// reported yet. A reply whose four token columns are all empty counts as unreported.

const SETTLED = "m.role = 'assistant' AND m.status NOT IN ('queued', 'streaming', 'stopping')";
const UNREPORTED =
  "m.input_tokens IS NULL AND m.output_tokens IS NULL AND m.cache_read_tokens IS NULL AND m.cache_write_tokens IS NULL";
const TOKENS =
  "COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0) + COALESCE(m.cache_read_tokens, 0) + COALESCE(m.cache_write_tokens, 0)";

// PostgreSQL reads COUNT and SUM as bigint or numeric text, so every count is read back as a number.
const count = (value: unknown) => Number(value ?? 0);
const decodeAgentId = Schema.decodeUnknownSync(AgentId);
const decodeStatus = Schema.decodeUnknownSync(AgentStatus);
const isRuntime = Schema.is(RuntimeKind);

const hobRow = (row: Readonly<Record<string, unknown>>): HobUsage => ({
  hobId: decodeAgentId(row.hobId),
  hobName: String(row.hobName),
  hobStatus: decodeStatus(row.hobStatus),
  runtime: isRuntime(row.runtime) ? row.runtime : null,
  model: typeof row.model === "string" ? row.model : null,
  replies: count(row.replies),
  unreported: count(row.unreported),
  inputTokens: count(row.inputTokens),
  outputTokens: count(row.outputTokens),
  cacheReadTokens: count(row.cacheReadTokens),
  cacheWriteTokens: count(row.cacheWriteTokens),
});

const hourRow = (row: Readonly<Record<string, unknown>>): HourUsage => ({
  hour: `${String(row.hour)}:00:00.000Z`,
  replies: count(row.replies),
  tokens: count(row.tokens),
});

export class UsageLedger extends Context.Service<
  UsageLedger,
  {
    /** What every hob's replies started from `since` until `until` (ISO 8601) used. */
    readonly usage: (
      since: string,
      until: string,
    ) => Effect.Effect<{ readonly hobs: ReadonlyArray<HobUsage>; readonly hours: ReadonlyArray<HourUsage> }>;
  }
>()("@hobbots/persistence/UsageLedger") {
  static readonly layer = Layer.effect(
    UsageLedger,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return UsageLedger.of({
        usage: (since, until) =>
          Effect.all(
            [
              sql<Record<string, unknown>>`
                SELECT t.agent_id AS hob_id, a.name AS hob_name, a.status AS hob_status, m.runtime, m.model,
                  COUNT(*) AS replies,
                  SUM(CASE WHEN ${sql.literal(UNREPORTED)} THEN 1 ELSE 0 END) AS unreported,
                  COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read_tokens,
                  COALESCE(SUM(m.cache_write_tokens), 0) AS cache_write_tokens
                FROM messages m JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = t.agent_id
                WHERE ${sql.literal(SETTLED)} AND m.created_at >= ${since} AND m.created_at < ${until}
                GROUP BY t.agent_id, a.name, a.status, m.runtime, m.model
                ORDER BY t.agent_id, m.runtime, m.model`,
              // Message times are ISO 8601 text in UTC, so their first 13 characters name the hour.
              sql<Record<string, unknown>>`
                SELECT SUBSTR(m.created_at, 1, 13) AS hour, COUNT(*) AS replies, SUM(${sql.literal(TOKENS)}) AS tokens
                FROM messages m
                WHERE ${sql.literal(SETTLED)} AND m.created_at >= ${since} AND m.created_at < ${until}
                GROUP BY SUBSTR(m.created_at, 1, 13)
                ORDER BY hour`,
            ],
            { concurrency: 1 },
          ).pipe(
            Effect.map(([hobs, hours]) => ({ hobs: hobs.map(hobRow), hours: hours.map(hourRow) })),
            Effect.orDie,
          ),
      });
    }),
  );
}
