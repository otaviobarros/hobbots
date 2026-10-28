import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const insertAndCount = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM agents`;
    yield* sql`INSERT INTO agents ${sql.insert({
      id: "aldric",
      name: "Aldric",
      role: "Guide",
      runtime: "claude-code",
      instructions: "",
      createdAt: "2026-10-28T00:00:00.000Z",
    })}`;
    const applied = yield* sql<{ name: string }>`SELECT name FROM effect_sql_migrations`;
    return { before: Number(before[0]?.count), applied: applied.length };
  }).pipe(Effect.provide(TestDatabase), Effect.runPromise);

describe("TestDatabase", () => {
  // covers DP-003
  it("[TC-DP-001] gives every build a fresh database with every migration applied", async () => {
    const first = await insertAndCount();
    const second = await insertAndCount();
    expect(first).toEqual({ before: 0, applied: Object.keys(migrations).length });
    expect(second).toEqual(first);
  });
});
