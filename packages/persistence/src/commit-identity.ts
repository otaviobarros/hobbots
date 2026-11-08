import { CodingSetupDismissals, HubCommitIdentities } from "@hobbots/agents";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

const Row = Schema.Struct({ name: Schema.String, email: Schema.String });

/** Who hobs on the user's account commit as when the user's Git config sets no identity (migration 0063). */
export const HubCommitIdentityRepository = Layer.effect(
  HubCommitIdentities,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return HubCommitIdentities.of({
      get: sql`SELECT name, email FROM commit_identity WHERE id = 1`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : Schema.decodeUnknownEffect(Row)(rows[0]),
        ),
        Effect.orDie,
      ),
      // A new answer replaces the old one in the same statement.
      save: (identity, at) =>
        sql`
          INSERT INTO commit_identity (id, name, email, set_at)
          VALUES (1, ${identity.name}, ${identity.email}, ${at})
          ON CONFLICT (id) DO UPDATE
          SET name = excluded.name, email = excluded.email, set_at = excluded.set_at
        `.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);

/** Where the user said not to ask whether a hob will write code (migration 0077, #1241). */
export const CodingSetupDismissalRepository = Layer.effect(
  CodingSetupDismissals,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return CodingSetupDismissals.of({
      list: sql<{ scope: string }>`SELECT scope FROM coding_setup_dismissals ORDER BY dismissed_at, scope`.pipe(
        Effect.map((rows) => rows.map((row) => row.scope)),
        Effect.orDie,
      ),
      dismiss: (scope, at) =>
        sql`
          INSERT INTO coding_setup_dismissals (scope, dismissed_at) VALUES (${scope}, ${at})
          ON CONFLICT (scope) DO NOTHING
        `.pipe(Effect.asVoid, Effect.orDie),
      clear: sql`DELETE FROM coding_setup_dismissals`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
