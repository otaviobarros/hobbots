import { GitHubAccounts } from "@hobbots/agents";
import { GitHubAccount } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** The GitHub account the hub connected (migration 0027): one row at most, with no token in it. */
export const GitHubAccountRepository = Layer.effect(
  GitHubAccounts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return GitHubAccounts.of({
      get: sql`SELECT source, login, connected_at FROM github_account WHERE id = 1`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : Schema.decodeUnknownEffect(GitHubAccount)(rows[0]),
        ),
        Effect.orDie,
      ),
      // A new connection replaces the old one in the same statement.
      save: (account) =>
        sql`
          INSERT INTO github_account (id, source, login, connected_at)
          VALUES (1, ${account.source}, ${account.login}, ${account.connectedAt})
          ON CONFLICT (id) DO UPDATE
          SET source = excluded.source, login = excluded.login, connected_at = excluded.connected_at
        `.pipe(Effect.asVoid, Effect.orDie),
      clear: sql`DELETE FROM github_account WHERE id = 1`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
