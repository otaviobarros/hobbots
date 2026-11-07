import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The GitHub Charm's operations are declared by the Charm (ADR 031): `read-github`,
// `open-pull-request` and `comment-github` become `github.read`, `github.open-pull-request` and
// `github.comment`, and the `PullRequest` and `GitHubComment` grant rules become `CharmSite` rules
// with the same folder and site values. This rewrites every stored override (migration 0015), the
// overrides a delegation gives (0024), approval requests' operations and offered rules (0018, 0022)
// and grants' operations and rules (0022), so each still answers the calls it answered before. Rows
// already in the new shape are left as they are, so running it again changes nothing.

const OPERATIONS: Readonly<Record<string, string>> = {
  "read-github": "github.read",
  "open-pull-request": "github.open-pull-request",
  "comment-github": "github.comment",
};

const renamed = (operation: string) => OPERATIONS[operation] ?? operation;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Overrides with every old operation name renamed. */
const renamedKeys = (overrides: Json): Json =>
  Object.fromEntries(Object.entries(overrides).map(([operation, decision]) => [renamed(operation), decision]));

/** A rule in the current shape. */
const currentRule = (rule: unknown): unknown => {
  if (!isRecord(rule)) return rule;
  if (rule._tag === "PullRequest") {
    return {
      _tag: "CharmSite",
      charm: "github",
      operation: "github.open-pull-request",
      cwd: rule.cwd,
      site: { repository: rule.repository, base: rule.base },
    };
  }
  if (rule._tag === "GitHubComment") {
    return {
      _tag: "CharmSite",
      charm: "github",
      operation: "github.comment",
      cwd: rule.cwd,
      site: { repository: rule.repository },
    };
  }
  return rule;
};

/** A delegation's authority with its overrides renamed. */
const currentAuthority = (authority: unknown): unknown =>
  isRecord(authority) && isRecord(authority.overrides)
    ? { ...authority, overrides: renamedKeys(authority.overrides) }
    : authority;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Rewrites one JSON text column of a table, row by row where the rewrite changes it, found by `keys`. */
  const rewriteJson = (
    table: string,
    column: string,
    rewrite: (value: unknown) => unknown,
    keys: ReadonlyArray<string> = ["id"],
  ) =>
    Effect.gen(function* () {
      // Aliased, since the client may rename result columns; every name here is this file's own.
      const aliases = keys.map((key, index) => `${key} AS k${index}`).join(", ");
      const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT ${aliases}, ${column} AS value FROM ${table}`);
      for (const row of rows) {
        const before = String(row.value);
        const next = JSON.stringify(rewrite(JSON.parse(before)));
        if (next === before) continue;
        const where = sql.and(keys.map((key, index) => sql`${sql(key)} = ${row[`k${index}`] as string | number}`));
        yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${next} WHERE ${where}`;
      }
    });

  /** Renames the old operations stored as text in one column of a table. */
  const renameOperations = (table: string) =>
    Effect.forEach(
      Object.entries(OPERATIONS),
      ([before, after]) => sql`UPDATE ${sql(table)} SET operation = ${after} WHERE operation = ${before}`,
      { discard: true },
    );

  const overrides = (value: unknown) => (isRecord(value) ? renamedKeys(value) : value);
  yield* rewriteJson("agents", "policy_overrides", overrides);
  yield* rewriteJson("agent_config_versions", "policy_overrides", overrides, ["agent_id", "version"]);
  yield* rewriteJson("delegations", "authority", currentAuthority);
  yield* renameOperations("approval_requests");
  yield* rewriteJson("approval_requests", "rules", (rules) => (Array.isArray(rules) ? rules.map(currentRule) : rules));
  yield* renameOperations("grants");
  yield* rewriteJson("grants", "rule", currentRule);
});
