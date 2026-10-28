import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import initial from "./0001_initial.ts";
import hobLook from "./0002_hob_look.ts";

/**
 * Every migration, keyed `<id>_<name>`. Effect's Migrator records applied ids and runs only
 * pending ones in id order. Add a new file per change; never edit a merged migration.
 * An explicit list (rather than a glob) works under tsx, Vitest and the bundled Electron app.
 */
export const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  "0001_initial": initial,
  "0002_hob_look": hobLook,
};
