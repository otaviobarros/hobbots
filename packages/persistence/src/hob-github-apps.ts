import { HobGitHubApps } from "@hobbots/agents";
import { AgentId, HobGitHubApp } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeApp = Schema.decodeUnknownEffect(HobGitHubApp);

/** Each hob's own GitHub App (migrations 0034 and 0093): its identity, never a secret, and what
 * could not be removed when it was disconnected or its hob retired. */
export const HobGitHubAppRepository = Layer.effect(
  HobGitHubApps,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = (agentId: AgentId) =>
      sql`
        SELECT app_id, client_id, slug, owner, origin, bot_user_id, html_url, connected_at, left_over
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
          }).pipe(Effect.map((app) => ({ app, leftOver: typeof row.leftOver === "string" ? row.leftOver : null })));
        }),
        Effect.orDie,
      );
    return HobGitHubApps.of({
      get: (agentId) =>
        find(agentId).pipe(Effect.map((found) => (found === null || found.leftOver !== null ? null : found.app))),
      leftOver: (agentId) =>
        find(agentId).pipe(
          Effect.map((found) =>
            found === null || found.leftOver === null ? null : { app: found.app, problem: found.leftOver },
          ),
        ),
      // A new app replaces the hob's old one in the same statement.
      save: (agentId, app) =>
        sql`
          INSERT INTO hob_github_apps
            (agent_id, app_id, client_id, slug, owner, origin, bot_user_id, html_url, connected_at)
          VALUES (${agentId}, ${app.appId}, ${app.clientId}, ${app.slug}, ${app.owner}, ${app.origin},
            ${app.botUserId}, ${app.htmlUrl}, ${app.connectedAt})
          ON CONFLICT (agent_id) DO UPDATE
          SET app_id = excluded.app_id, client_id = excluded.client_id, slug = excluded.slug,
            owner = excluded.owner, origin = excluded.origin, bot_user_id = excluded.bot_user_id, html_url = excluded.html_url,
            connected_at = excluded.connected_at, left_over = NULL
        `.pipe(Effect.asVoid, Effect.orDie),
      leave: (agentId, problem) =>
        sql`UPDATE hob_github_apps SET left_over = ${problem} WHERE agent_id = ${agentId}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      // Any hob's row counts, left over or not: one app is one hob's name (ADR 022).
      holder: (appId) =>
        sql`SELECT agent_id FROM hob_github_apps WHERE app_id = ${appId}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : AgentId.make(String(rows[0].agentId)))),
          Effect.orDie,
        ),
      remove: (agentId) =>
        sql`DELETE FROM hob_github_apps WHERE agent_id = ${agentId}`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
