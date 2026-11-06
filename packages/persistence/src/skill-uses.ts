import type { SkillLibraryShape } from "@hobbots/agents";
import { SkillUse } from "@hobbots/domain";
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
): Pick<SkillLibraryShape, "recordUse" | "uses"> => ({
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
      ])} ORDER BY used_at DESC, id DESC`.pipe(Effect.flatMap((rows) => Effect.forEach(rows, useOf))),
    ),
});
