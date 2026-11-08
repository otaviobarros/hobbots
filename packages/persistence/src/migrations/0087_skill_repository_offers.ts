import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A repository's own skills (ADR 029, #1098). Hobbots offers the skills a repository a hob works in
// holds in `.claude/skills` and `.agents/skills` once per project. When you import them or say Not now,
// `skill_repository_offers` keeps the project's identity, the skill folders the repository held then
// (as JSON) and when; the offer comes back only for a skill folder that is not among them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE skill_repository_offers (
      project TEXT PRIMARY KEY,
      folders TEXT NOT NULL,
      closed_at TEXT NOT NULL
    )
  `;
});
