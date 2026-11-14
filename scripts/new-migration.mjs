/**
 * Adds a persistence migration named by the UTC second it was made (ADR 040):
 * `pnpm migration:new thread_members` writes
 * `packages/persistence/src/migrations/20261113231542_thread_members.ts`.
 *
 * No list names the migrations, and the migrator runs every one a database has not applied, whatever
 * its id, so two pull requests that each add one never edit the same file and never renumber because
 * of merge order. Two branches clash only if each makes a migration in the same second: the id is
 * then refused, naming both files, by the pull request's own CI (it runs on the pull request merged
 * into `main`) or by the merge queue, and running this script again on one branch fixes it.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MIGRATIONS_FOLDER = join(import.meta.dirname, "../packages/persistence/src/migrations");

/** The second's id, such as 20261113231542 for 23:15:42 UTC on 13 November 2026. */
export const secondId = (date) => date.toISOString().slice(0, 19).replace(/\D/g, "");

/**
 * The file name for a new migration made at `date`. A name is lowercase words joined by `_`. A second
 * another migration in `taken` already uses moves to the next free one, so two made at once differ.
 */
export const migrationFileName = (name, date, taken) => {
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name)) {
    throw new Error(`"${name}" is not a migration name: use lowercase words joined by _, such as thread_members`);
  }
  const used = new Set([...taken].map((file) => file.split("_")[0]));
  let at = new Date(Math.floor(date.getTime() / 1000) * 1000);
  while (used.has(secondId(at))) at = new Date(at.getTime() + 1000);
  return `${secondId(at)}_${name}.ts`;
};

const TEMPLATE = `import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What this migration changes, and why (link its issue).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql\`SELECT 1\`;
});
`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const name = process.argv[2];
  if (name === undefined) {
    console.error("Usage: pnpm migration:new <name>, such as pnpm migration:new thread_members");
    process.exit(1);
  }
  const file = migrationFileName(name, new Date(), readdirSync(MIGRATIONS_FOLDER));
  const path = join(MIGRATIONS_FOLDER, file);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  writeFileSync(path, TEMPLATE);
  console.log(`Wrote ${path}`);
}
