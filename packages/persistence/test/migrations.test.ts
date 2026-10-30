import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/index.ts";
import hobBrain from "../src/migrations/0005_hob_brain.ts";
import hobConfigVersions from "../src/migrations/0007_hob_config_versions.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

/** The migrations that ran before the one with this id, to check it against existing rows. */
const migrationsBefore = (id: string) =>
  Object.fromEntries(Object.entries(migrations).filter(([key]) => key < id)) as typeof migrations;

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

describe("0005_hob_brain", () => {
  // covers AG-001, DP-003
  it("[TC-AG-001] keeps an existing hob's role as its craft and leaves its effort at the model's default", async () => {
    const earlier = migrationsBefore("0005");
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

describe("0007_hob_config_versions", () => {
  // covers AG-002, DP-003
  it("[TC-AG-020] makes every existing hob's configuration its version 1 and marks its replies with it", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "aldric",
        name: "Aldric",
        craft: "Guide",
        runtime: "claude-code",
        model: "sonnet",
        effort: "high",
        instructions: "Be brief.",
        lookSeed: 2 ** 32 - 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO threads ${sql.insert({
        id: "t1",
        agentId: "aldric",
        title: "Hi",
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
      })}`;
      for (const [seq, role] of [
        [1, "user"],
        [2, "assistant"],
      ] as const) {
        yield* sql`INSERT INTO messages ${sql.insert({
          id: `m${seq}`,
          threadId: "t1",
          role,
          content: "",
          status: "complete",
          createdAt: "2026-10-28T00:00:00.000Z",
          seq,
        })}`;
      }
      yield* hobConfigVersions;
      return {
        versions: yield* sql`SELECT * FROM agent_config_versions`,
        agents: yield* sql<{ configVersion: number }>`SELECT config_version FROM agents`,
        messages: yield* sql<{ id: string; configVersion: number | null }>`
          SELECT id, config_version FROM messages ORDER BY seq
        `,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0007"))), Effect.runPromise);

    expect(result.versions.map((row) => ({ ...row, lookSeed: Number(row.lookSeed) }))).toEqual([
      {
        agentId: "aldric",
        version: 1,
        craft: "Guide",
        model: "sonnet",
        effort: "high",
        instructions: "Be brief.",
        lookSeed: 2 ** 32 - 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      },
    ]);
    expect(result.agents).toEqual([{ configVersion: 1 }]);
    expect(result.messages).toEqual([
      { id: "m1", configVersion: null },
      { id: "m2", configVersion: 1 },
    ]);
  });
});
