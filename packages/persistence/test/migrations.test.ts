import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

describe("migrations", () => {
  // covers DP-003
  it("[TC-DP-003] apply every migration in order on an empty database and record each one", async () => {
    const applied = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ migrationId: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
    }).pipe(Effect.provide(TestDatabase), Effect.runPromise);

    const expected = Object.keys(migrations)
      .sort()
      .map((key) => {
        const [id, ...name] = key.split("_");
        return { migrationId: Number(id), name: name.join("_") };
      });
    expect(applied).toEqual(expected);
  });

  it("use unique, sequential ids", () => {
    const ids = Object.keys(migrations).map((key) => Number(key.split("_")[0]));
    expect(ids).toEqual(ids.map((_, index) => index + 1));
  });
});
