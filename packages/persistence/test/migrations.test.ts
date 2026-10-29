import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/index.ts";
import hobBrain from "../src/migrations/0004_hob_brain.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

describe("migrations", () => {
  // covers DP-003
  it("[TC-DP-003] applies every migration in order on an empty database and records each one", async () => {
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

describe("0004_hob_brain", () => {
  // covers AG-001, DP-003
  it("[TC-AG-001] keeps an existing hob's role as its craft and leaves its effort at the model's default", async () => {
    const { "0004_hob_brain": _, ...earlier } = migrations;
    const rows = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "aldric",
        name: "Aldric",
        role: "Guide",
        runtime: "claude-code",
        model: "sonnet",
        instructions: "",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* hobBrain;
      return yield* sql<{ craft: string; model: string | null; effort: string | null }>`
        SELECT craft, model, effort FROM agents
      `;
    }).pipe(Effect.provide(TestDatabaseAt(earlier)), Effect.runPromise);

    expect(rows).toEqual([{ craft: "Guide", model: "sonnet", effort: null }]);
  });
});
