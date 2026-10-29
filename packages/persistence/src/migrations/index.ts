import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import initial from "./0001_initial.ts";
import hobLook from "./0002_hob_look.ts";
import lookSeedBigint from "./0003_look_seed_bigint.ts";
import hobBrain from "./0004_hob_brain.ts";

/**
 * Every migration, keyed `<id>_<name>`. Effect's Migrator records applied ids and runs only
 * pending ones in id order. Add a new file per change; never edit a merged migration.
 * An explicit list (rather than a glob) works under tsx, Vitest and the bundled Electron app.
 */
export const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  "0001_initial": initial,
  "0002_hob_look": hobLook,
  "0003_look_seed_bigint": lookSeedBigint,
  "0004_hob_brain": hobBrain,
};
