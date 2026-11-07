import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A Charm call names its Charm, and keeps the text the hob is told once reading back finds it took
// effect apart from its plan (ADR 031): the hub action pipeline runs every Charm's writes, so a
// call's words name its Charm, and a call's plan holds only what the hub fixed when it decided.
// Every call stored so far is the GitHub Charm's. `appliedText` moves out of each plan's JSON into
// its own column, and a plan without it, which no hub wrote, is told GitHub's fallback.

/** A call's plan without its applied text, and the text, from its stored JSON. */
const split = (plan: string) => {
  const { appliedText, ...rest } = JSON.parse(plan) as Record<string, unknown>;
  return {
    plan: JSON.stringify(rest),
    appliedText: typeof appliedText === "string" ? appliedText : "GitHub shows it took effect.",
  };
};

export default Effect.gen(function* () {
  // Rows are read and written by their column names, as they are stored.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`ALTER TABLE charm_calls ADD COLUMN charm TEXT NOT NULL DEFAULT 'GitHub'`;
  yield* sql`ALTER TABLE charm_calls ADD COLUMN applied_text TEXT NOT NULL DEFAULT ''`;
  const rows = yield* sql<{ agent_id: string; call_key: string; attempt: string; plan: string }>`
    SELECT agent_id, call_key, attempt, plan FROM charm_calls`;
  for (const row of rows) {
    const { plan, appliedText } = split(row.plan);
    yield* sql`UPDATE charm_calls SET plan = ${plan}, applied_text = ${appliedText}
      WHERE agent_id = ${row.agent_id} AND call_key = ${row.call_key} AND attempt = ${row.attempt}`;
  }
});
