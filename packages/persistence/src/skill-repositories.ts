import { SkillRepositoryOffers } from "@hobbots/agents";
import { MemoryProjectIdentity } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { sqlOrDie } from "./sql-errors.ts";

const decodeFolders = Schema.decodeUnknownEffect(Schema.Array(Schema.String));

/** Where Hobbots stopped offering a repository's own skills (migration 0083, ADR 029). */
export const SkillRepositoryOffersLive = Layer.effect(
  SkillRepositoryOffers,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return SkillRepositoryOffers.of({
      closed: sqlOrDie(
        sql<{ readonly project: string; readonly folders: string }>`SELECT project, folders
          FROM skill_repository_offers ORDER BY project`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.map(
                decodeFolders(JSON.parse(row.folders)).pipe(Effect.orDie),
                (folders) => [MemoryProjectIdentity.make(row.project), folders] as const,
              ),
            ),
          ),
          Effect.map((pairs) => new Map(pairs)),
        ),
      ),
      // Closing it again replaces what it saw, in the same statement.
      close: (project, folders, at) =>
        sqlOrDie(
          sql`INSERT INTO skill_repository_offers ${sql.insert({ project, folders: JSON.stringify(folders), closed_at: at })}
            ON CONFLICT (project) DO UPDATE SET folders = excluded.folders, closed_at = excluded.closed_at`.pipe(
            Effect.asVoid,
          ),
        ),
    });
  }),
);
