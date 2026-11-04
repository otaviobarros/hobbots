import {
  AgentId,
  AgentStatus,
  type HobUsage,
  type MinuteUsage,
  QuestId,
  type QuestUsage,
  RuntimeKind,
} from "@hobbots/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

// What hobs' replies used (OP-002), summed in SQL from the usage columns of migration 0037 and the
// runtime and model of migration 0020. Only settled replies count: one still streaming has not
// reported yet. A reply whose four token columns are all empty counts as unreported. A reply counts
// for the Quest whose chat it was written in while the Quest ran; when several ran there at once,
// for the one that started last. A sub-quest's replies count for the Quest at the top.

const SETTLED = "m.role = 'assistant' AND m.status NOT IN ('queued', 'streaming', 'stopping')";
const UNREPORTED =
  "m.input_tokens IS NULL AND m.output_tokens IS NULL AND m.cache_read_tokens IS NULL AND m.cache_write_tokens IS NULL";
const TOKENS =
  "COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0) + COALESCE(m.cache_read_tokens, 0) + COALESCE(m.cache_write_tokens, 0)";

// PostgreSQL reads COUNT and SUM as bigint or numeric text, so every count is read back as a number.
const count = (value: unknown) => Number(value ?? 0);
const decodeAgentId = Schema.decodeUnknownSync(AgentId);
const decodeStatus = Schema.decodeUnknownSync(AgentStatus);
const decodeQuestId = Schema.decodeUnknownSync(QuestId);
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

const questRow = (row: Readonly<Record<string, unknown>>): QuestUsage => ({
  questId: row.questId === null || row.questId === undefined ? null : decodeQuestId(row.questId),
  goal: typeof row.goal === "string" ? row.goal : null,
  leadName: typeof row.leadName === "string" ? row.leadName : null,
  party: count(row.party),
  chats: count(row.chats),
  replies: count(row.replies),
  unreported: count(row.unreported),
  tokens: count(row.tokens),
});

// The top Quest a settled reply was written under: one that ran in its chat when it started.
const QUEST_OF_REPLY = `(SELECT q.id FROM quests q
  WHERE q.thread_id = m.thread_id AND q.parent_quest_id IS NULL AND q.created_at <= m.created_at
    AND (q.ended_at IS NULL OR q.ended_at >= m.created_at)
  ORDER BY q.created_at DESC LIMIT 1)`;

const minuteRow = (row: Readonly<Record<string, unknown>>): MinuteUsage => ({
  minute: `${String(row.minute)}:00.000Z`,
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
    ) => Effect.Effect<{
      readonly hobs: ReadonlyArray<HobUsage>;
      readonly quests: ReadonlyArray<QuestUsage>;
      readonly minutes: ReadonlyArray<MinuteUsage>;
    }>;
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
              // A Quest's party is every hob that owns a Task in its tree, the lead included.
              sql<Record<string, unknown>>`
                SELECT u.quest_id, q.goal, a.name AS lead_name,
                  (SELECT COUNT(DISTINCT p.owner_id) FROM tasks p
                    WHERE p.root_id = (SELECT r.root_id FROM tasks r WHERE r.id = q.task_id)) AS party,
                  COUNT(DISTINCT u.thread_id) AS chats, COUNT(*) AS replies,
                  SUM(u.unreported) AS unreported, SUM(u.tokens) AS tokens
                FROM (
                  SELECT m.thread_id, ${sql.literal(QUEST_OF_REPLY)} AS quest_id,
                    CASE WHEN ${sql.literal(UNREPORTED)} THEN 1 ELSE 0 END AS unreported,
                    ${sql.literal(TOKENS)} AS tokens
                  FROM messages m
                  WHERE ${sql.literal(SETTLED)} AND m.created_at >= ${since} AND m.created_at < ${until}
                ) u
                LEFT JOIN quests q ON q.id = u.quest_id LEFT JOIN agents a ON a.id = q.lead_id
                GROUP BY u.quest_id, q.goal, q.task_id, a.name
                ORDER BY CASE WHEN u.quest_id IS NULL THEN 0 ELSE 1 END, u.quest_id`,
              // Message times are ISO 8601 text in UTC, so their first 16 characters name the minute.
              // Some time zones sit a quarter or half hour off UTC, so an hour would split their days.
              sql<Record<string, unknown>>`
                SELECT SUBSTR(m.created_at, 1, 16) AS minute, COUNT(*) AS replies, SUM(${sql.literal(TOKENS)}) AS tokens
                FROM messages m
                WHERE ${sql.literal(SETTLED)} AND m.created_at >= ${since} AND m.created_at < ${until}
                GROUP BY SUBSTR(m.created_at, 1, 16)
                ORDER BY minute`,
            ],
            { concurrency: 1 },
          ).pipe(
            Effect.map(([hobs, quests, minutes]) => ({
              hobs: hobs.map(hobRow),
              quests: quests.map(questRow),
              minutes: minutes.map(minuteRow),
            })),
            Effect.orDie,
          ),
      });
    }),
  );
}
