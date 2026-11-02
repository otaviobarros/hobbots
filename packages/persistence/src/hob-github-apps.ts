import { HobGitHubApps } from "@hobbots/agents";
import { HobGitHubApp } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeApp = Schema.decodeUnknownEffect(HobGitHubApp);

/** Each hob's own GitHub App (migration 0033): its identity, never a secret. */
export const HobGitHubAppRepository = Layer.effect(
  HobGitHubApps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return HobGitHubApps.of({
      get: (agentId) =>
        sql`
          SELECT app_id, client_id, slug, owner, bot_user_id, html_url, connected_at
          FROM hob_github_apps WHERE agent_id = ${agentId}
        `.pipe(
          Effect.flatMap((rows) => {
            const row = rows[0];
            if (row === undefined) return Effect.succeed(null);
            // PostgreSQL hands BIGINT back as text.
            return decodeApp({
              ...row,
              appId: Number(row.appId),
              botUserId: row.botUserId === null ? null : Number(row.botUserId),
            });
          }),
          Effect.orDie,
        ),
      // A new app replaces the hob's old one in the same statement.
      save: (agentId, app) =>
        sql`
          INSERT INTO hob_github_apps (agent_id, app_id, client_id, slug, owner, bot_user_id, html_url, connected_at)
          VALUES (${agentId}, ${app.appId}, ${app.clientId}, ${app.slug}, ${app.owner}, ${app.botUserId},
            ${app.htmlUrl}, ${app.connectedAt})
          ON CONFLICT (agent_id) DO UPDATE
          SET app_id = excluded.app_id, client_id = excluded.client_id, slug = excluded.slug,
            owner = excluded.owner, bot_user_id = excluded.bot_user_id, html_url = excluded.html_url,
            connected_at = excluded.connected_at
        `.pipe(Effect.asVoid, Effect.orDie),
      remove: (agentId) =>
        sql`DELETE FROM hob_github_apps WHERE agent_id = ${agentId}`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
