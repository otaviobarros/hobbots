/// <reference types="vite/client" />
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";

type Migration = Effect.Effect<void, unknown, SqlClient.SqlClient>;

/** A migration file: `<id>_<name>.ts`, where the id is 0001 to 0114 or, since ADR 040, the UTC second it was made, such as 20261113231542. */
const FILE = /^(\d+_\w+)\.ts$/;

/**
 * Reads the folder when no bundler built this module, as under tsx. Each file is loaded with
 * `require`, which tsx and Node both run on TypeScript, so the record is ready when this module is.
 */
const fromFolder = (): Record<string, { readonly default: Migration }> => {
  const folder = new URL("./", import.meta.url);
  const load = createRequire(import.meta.url);
  return Object.fromEntries(
    readdirSync(folder)
      .filter((file) => FILE.test(file))
      .map((file) => [`./${file}`, load(fileURLToPath(new URL(file, folder)))]),
  );
};

/**
 * Vite (the server and desktop builds) and Vitest list the folder when they build this module; tsx
 * has no `import.meta.env`, so the folder is read instead. Either way no list is kept by hand, so two
 * pull requests that each add a migration never touch the same file (ADR 040).
 */
const files: Record<string, { readonly default: Migration }> = import.meta.env
  ? import.meta.glob<{ readonly default: Migration }>("./[0-9]*_*.ts", { eager: true })
  : fromFolder();

/**
 * Every migration in this folder, keyed `<id>_<name>` and sorted by id. The migrator records the ids
 * it applied and runs every other one, in id order (ADR 040). Add a new file per change with
 * `pnpm migration:new <name>`; never edit a merged migration.
 */
export const migrations: Record<string, Migration> = Object.fromEntries(
  Object.entries(files)
    .map(([path, module]) => [path.slice(2, -3), module.default] as const)
    .sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
);
