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

// What hobs used (OP-002): their chat replies and the turns of their Attempts outside any chat, a
// planned step's or a party member's (#1011), summed in SQL. A reply carries its usage in the columns
// of migration 0037 and its runtime and model in those of migration 0020; a turn outside a chat has a
// row of its own (migration 0060). Only settled replies count: one still streaming has not reported
// yet, and neither has a turn still running. A reply or turn whose four token columns are all empty
// counts as unreported. A reply counts for the Quest whose chat it was written in while the Quest ran;
// when several ran there at once, for the one that started last. A turn counts for the Quest at the
// top of its Task's tree, so a Quest's total is its whole party's. A sub-quest's replies count for the
// Quest at the top.

const SETTLED = "m.role = 'assistant' AND m.status NOT IN ('queued', 'streaming', 'stopping')";
// A turn has ended, or its Attempt has: one the hub stopped before it saw the turn end counts once
// the hub ends its Attempt on its next start.
const SETTLED_TURN = `(u.ended_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM attempts x
  WHERE x.id = u.attempt_id AND x.state IN ('starting', 'running')))`;
const UNREPORTED =
  "s.input_tokens IS NULL AND s.output_tokens IS NULL AND s.cache_read_tokens IS NULL AND s.cache_write_tokens IS NULL";
const TOKENS =
  "COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0) + COALESCE(s.cache_read_tokens, 0) + COALESCE(s.cache_write_tokens, 0)";

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

// The top Quest of the tree a turn's Task is in, if a Quest runs there.
const QUEST_OF_TURN = `(SELECT q.id FROM attempts x JOIN tasks k ON k.id = x.task_id
    JOIN tasks r ON r.root_id = k.root_id JOIN quests q ON q.task_id = r.id
  WHERE x.id = u.attempt_id AND q.parent_quest_id IS NULL
  ORDER BY q.created_at DESC LIMIT 1)`;

const minuteRow = (row: Readonly<Record<string, unknown>>): MinuteUsage => ({
  minute: `${String(row.minute)}:00.000Z`,
  replies: count(row.replies),
  tokens: count(row.tokens),
});

export class UsageLedger extends Context.Service<
  UsageLedger,
  {
    /** What every hob's replies and turns outside a chat started from `since` until `until` (ISO 8601) used. */
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
        usage: (since, until) => {
          // Every settled reply and every turn outside a chat that started in the period: who spent it,
          // on what, when, in which chat (none for a turn) and for which Quest.
          const spent = sql`(
            SELECT t.agent_id AS hob_id, m.runtime, m.model, m.created_at AS at, m.thread_id,
              ${sql.literal(QUEST_OF_REPLY)} AS quest_id,
              m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_write_tokens
            FROM messages m JOIN threads t ON t.id = m.thread_id
            WHERE ${sql.literal(SETTLED)} AND m.created_at >= ${since} AND m.created_at < ${until}
            UNION ALL
            SELECT u.agent_id, u.runtime, u.model, u.started_at, NULL, ${sql.literal(QUEST_OF_TURN)},
              u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
            FROM attempt_turns u
            WHERE ${sql.literal(SETTLED_TURN)} AND u.started_at >= ${since} AND u.started_at < ${until}
          ) s`;
          return Effect.all(
            [
              sql<Record<string, unknown>>`
                SELECT s.hob_id, a.name AS hob_name, a.status AS hob_status, s.runtime, s.model,
                  COUNT(*) AS replies,
                  SUM(CASE WHEN ${sql.literal(UNREPORTED)} THEN 1 ELSE 0 END) AS unreported,
                  COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read_tokens,
                  COALESCE(SUM(s.cache_write_tokens), 0) AS cache_write_tokens
                FROM ${spent} JOIN agents a ON a.id = s.hob_id
                GROUP BY s.hob_id, a.name, a.status, s.runtime, s.model
                ORDER BY s.hob_id, s.runtime, s.model`,
              // A Quest's party is every hob that owns a Task in its tree, the lead included.
              sql<Record<string, unknown>>`
                SELECT s.quest_id, q.goal, a.name AS lead_name,
                  (SELECT COUNT(DISTINCT p.owner_id) FROM tasks p
                    WHERE p.root_id = (SELECT r.root_id FROM tasks r WHERE r.id = q.task_id)) AS party,
                  COUNT(DISTINCT s.thread_id) AS chats, COUNT(*) AS replies,
                  SUM(CASE WHEN ${sql.literal(UNREPORTED)} THEN 1 ELSE 0 END) AS unreported,
                  SUM(${sql.literal(TOKENS)}) AS tokens
                FROM ${spent}
                LEFT JOIN quests q ON q.id = s.quest_id LEFT JOIN agents a ON a.id = q.lead_id
                GROUP BY s.quest_id, q.goal, q.task_id, a.name
                ORDER BY CASE WHEN s.quest_id IS NULL THEN 0 ELSE 1 END, s.quest_id`,
              // Times are ISO 8601 text in UTC, so their first 16 characters name the minute. Some time
              // zones sit a quarter or half hour off UTC, so an hour would split their days.
              sql<Record<string, unknown>>`
                SELECT SUBSTR(s.at, 1, 16) AS minute, COUNT(*) AS replies, SUM(${sql.literal(TOKENS)}) AS tokens
                FROM ${spent}
                GROUP BY SUBSTR(s.at, 1, 16)
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
          );
        },
      });
    }),
  );
}
