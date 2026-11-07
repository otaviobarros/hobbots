import type { SkillLibraryShape } from "@hobbots/agents";
import { SkillId, SkillUse, SkillUseCounts } from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface UseRow {
  readonly id: string;
  readonly source: string;
  readonly skillId: string | null;
  readonly name: string;
  readonly pin: string | null;
  readonly number: unknown;
  readonly explicit: unknown;
  readonly agentId: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly usedAt: string;
}

const decodeUse = Schema.decodeUnknownEffect(SkillUse);
const decodeCounts = Schema.decodeUnknownEffect(SkillUseCounts);

/** How many uses a read answers unless it asks for fewer or more. */
const DEFAULT_LIMIT = 100;

const useOf = (row: UseRow) =>
  decodeUse({
    id: row.id,
    source: row.source,
    skillId: row.skillId,
    name: row.name,
    pin: row.pin,
    number: row.number === null ? null : Number(row.number),
    explicit: Boolean(Number(row.explicit)),
    agentId: row.agentId,
    threadId: row.threadId,
    messageId: row.messageId,
    at: row.usedAt,
  }).pipe(Effect.orDie);

/** The uses of skills (migration 0069, ADR 029 The use line): each journaled as `SkillUsed`. */
export const skillUses = (
  sql: SqlClient.SqlClient,
  change: ReturnType<typeof makeJournaledChange>,
): Pick<SkillLibraryShape, "recordUse" | "uses" | "useCounts" | "usesSince" | "lastUses"> => ({
  recordUse: (use) =>
    change<SkillUse, SqlError.SqlError>(() =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO skill_uses ${sql.insert({
          id: use.id,
          source: use.source,
          skill_id: use.skillId,
          name: use.name,
          pin: use.pin,
          number: use.number,
          explicit: use.explicit ? 1 : 0,
          agent_id: use.agentId,
          thread_id: use.threadId,
          message_id: use.messageId,
          used_at: use.at,
        })}`;
        return { value: use, events: [{ _tag: "SkillUsed", use }] };
      }),
    ),
  uses: (filter) =>
    sqlOrDie(
      sql<UseRow>`SELECT * FROM skill_uses WHERE ${sql.and([
        ...(filter.skillId === undefined ? [] : [sql`skill_id = ${filter.skillId}`]),
        ...(filter.agentId === undefined ? [] : [sql`agent_id = ${filter.agentId}`]),
        ...(filter.messageId === undefined ? [] : [sql`message_id = ${filter.messageId}`]),
      ])} ORDER BY used_at DESC, id DESC LIMIT ${filter.limit ?? DEFAULT_LIMIT}`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, useOf)),
      ),
    ),
  useCounts: (skillId, since) =>
    sqlOrDie(
      Effect.gen(function* () {
        const [totals] = yield* sql<{ readonly total: unknown; readonly recent: unknown }>`
          SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN used_at > ${since} THEN 1 ELSE 0 END), 0) AS recent
          FROM skill_uses WHERE skill_id = ${skillId}`;
        const hobs = yield* sql<{ readonly agentId: string; readonly count: unknown; readonly lastAt: string }>`
          SELECT agent_id, COUNT(*) AS count, MAX(used_at) AS last_at FROM skill_uses
          WHERE skill_id = ${skillId} GROUP BY agent_id ORDER BY last_at DESC, agent_id`;
        const threads = yield* sql<{
          readonly threadId: string;
          readonly agentId: string;
          readonly count: unknown;
          readonly lastAt: string;
        }>`
          SELECT thread_id, agent_id, COUNT(*) AS count, MAX(used_at) AS last_at FROM skill_uses
          WHERE skill_id = ${skillId} AND thread_id IS NOT NULL
          GROUP BY thread_id, agent_id ORDER BY last_at DESC, thread_id`;
        return yield* decodeCounts({
          skillId,
          total: Number(totals?.total ?? 0),
          thisWeek: Number(totals?.recent ?? 0),
          hobs: hobs.map((row) => ({ agentId: row.agentId, count: Number(row.count), lastAt: row.lastAt })),
          threads: threads.map((row) => ({
            threadId: row.threadId,
            agentId: row.agentId,
            count: Number(row.count),
            lastAt: row.lastAt,
          })),
        }).pipe(Effect.orDie);
      }),
    ),
  usesSince: (since) =>
    sqlOrDie(
      sql<{ readonly skillId: string; readonly count: unknown }>`
        SELECT skill_id, COUNT(*) AS count FROM skill_uses
        WHERE skill_id IS NOT NULL AND used_at > ${since} GROUP BY skill_id ORDER BY skill_id`.pipe(
        Effect.map((rows) => rows.map((row) => ({ skillId: SkillId.make(row.skillId), count: Number(row.count) }))),
      ),
    ),
  // Each skill once: a library skill by its id, one from your organization by its name.
  lastUses: (agentId, limit) =>
    sqlOrDie(
      sql<UseRow>`
        SELECT * FROM skill_uses u WHERE u.agent_id = ${agentId} AND NOT EXISTS (
          SELECT 1 FROM skill_uses v WHERE v.agent_id = u.agent_id
            AND COALESCE(v.skill_id, v.source || ':' || v.name) = COALESCE(u.skill_id, u.source || ':' || u.name)
            AND (v.used_at > u.used_at OR (v.used_at = u.used_at AND v.id > u.id))
        ) ORDER BY u.used_at DESC, u.id DESC LIMIT ${limit}`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, useOf)),
      ),
    ),
});
