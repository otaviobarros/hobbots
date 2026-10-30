import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/index.ts";
import hobBrain from "../src/migrations/0005_hob_brain.ts";
import hobConfigVersions from "../src/migrations/0007_hob_config_versions.ts";
import hobStatus from "../src/migrations/0008_hob_status.ts";
import hobRetiredAt from "../src/migrations/0009_hob_retired_at.ts";
import hobRoles from "../src/migrations/0010_hob_roles.ts";
import hobIdentity from "../src/migrations/0013_hob_identity.ts";
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

describe("0008_hob_status", () => {
  // covers AG-006, DP-003
  it("[TC-AG-036] keeps every existing hob active", async () => {
    const rows = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "aldric",
        name: "Aldric",
        craft: "Guide",
        runtime: "claude-code",
        instructions: "",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* hobStatus;
      return yield* sql<{ id: string; status: string }>`SELECT id, status FROM agents`;
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0008"))), Effect.runPromise);

    expect(rows).toEqual([{ id: "aldric", status: "active" }]);
  });
});

describe("0009_hob_retired_at", () => {
  // covers AG-006, DP-003
  it("[TC-AG-060] keeps hobs retired before it, with no retirement time", async () => {
    const rows = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "aldric",
        name: "Aldric",
        craft: "Guide",
        runtime: "claude-code",
        instructions: "",
        status: "retired",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* hobRetiredAt;
      return yield* sql<{ id: string; status: string; retiredAt: string | null }>`
        SELECT id, status, retired_at FROM agents
      `;
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0009"))), Effect.runPromise);

    expect(rows).toEqual([{ id: "aldric", status: "retired", retiredAt: null }]);
  });
});

describe("0010_hob_roles", () => {
  // covers AG-001, AG-002, DP-003
  it("[TC-AG-072] moves every hob's craft to a role and keeps any other craft as its own title", async () => {
    const crafts = ["Helper", "Scribe", "Coder", "Researcher", "Bookkeeper", "Guide"];
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [index, craft] of crafts.entries()) {
        yield* sql`INSERT INTO agents ${sql.insert({
          id: `hob${index}`,
          name: craft,
          craft,
          runtime: "claude-code",
          instructions: "",
          lookSeed: index,
          lookColor: "moss",
          createdAt: "2026-10-28T00:00:00.000Z",
        })}`;
        yield* sql`INSERT INTO agent_config_versions ${sql.insert({
          agentId: `hob${index}`,
          version: 1,
          craft,
          instructions: "",
          lookSeed: index,
          lookColor: "moss",
          createdAt: "2026-10-28T00:00:00.000Z",
        })}`;
      }
      yield* hobRoles;
      const columns = sql.literal("role, role_title, sigil, hat, tool");
      return {
        agents: yield* sql`SELECT ${columns} FROM agents ORDER BY id`,
        versions: yield* sql`SELECT ${columns} FROM agent_config_versions ORDER BY agent_id`,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0010"))), Effect.runPromise);

    const expected = [
      { role: "assistant", roleTitle: "Assistant", sigil: "assistant", hat: null, tool: null },
      { role: "writer", roleTitle: "Writer", sigil: "writer", hat: null, tool: null },
      { role: "engineer", roleTitle: "Software engineer", sigil: "engineer", hat: null, tool: null },
      { role: "researcher", roleTitle: "Researcher", sigil: "researcher", hat: null, tool: null },
      { role: "bookkeeper", roleTitle: "Bookkeeper", sigil: "bookkeeper", hat: null, tool: null },
      { role: null, roleTitle: "Guide", sigil: "assistant", hat: null, tool: null },
    ];
    expect(result.agents).toEqual(expected);
    expect(result.versions).toEqual(expected);
  });
});

describe("0013_hob_identity", () => {
  // covers AG-002, DP-003
  it("[TC-AG-084] removes only the opening Hobbots wrote from every hob and version, and keeps the rest", async () => {
    const hobs = [
      // An old craft opening, then chores.
      [
        "Pip",
        "Assistant",
        "You are Pip, a hob in Hobbots. Your craft is Helper: does a bit of everything.\n\nYour chores, in the user's words:\nSort mail.",
      ],
      // A starter role's opening, alone.
      [
        "Wren",
        "Writer",
        "You are Wren, a hob in Hobbots. Your role is Writer: drafts emails, posts and documents with you.",
      ],
      // An opening for a role other than the saved one still goes.
      [
        "Ada",
        "QA engineer",
        "You are Ada, a hob in Hobbots. Your role is Writer: drafts emails, posts and documents with you.\nBe brief.",
      ],
      // A title in the user's own words, in both wordings.
      ["Fern", "Gardener", "You are Fern, a hob in Hobbots. Your role is Gardener.\n\nWater the plants."],
      ["Moss", "Guide", "You are Moss, a hob in Hobbots. You are good at guide."],
      // Openings the user changed, or never had, stay.
      [
        "Bram",
        "Writer",
        "You are Bram, a hob in Hobbots. Your role is Writer: drafts emails, posts and documents with you. Always ask first.",
      ],
      ["Ivy", "Writer", "You are Ivy, a hob in Hobbots. Always ask before deleting files."],
      ["Oak", "Writer", "Write short answers."],
    ] as const;
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [index, [name, roleTitle, instructions]] of hobs.entries()) {
        yield* sql`INSERT INTO agents ${sql.insert({
          id: `hob${index}`,
          name,
          roleTitle,
          runtime: "claude-code",
          instructions,
          lookSeed: index,
          lookColor: "moss",
          createdAt: "2026-10-30T00:00:00.000Z",
        })}`;
        for (const version of [1, 2]) {
          yield* sql`INSERT INTO agent_config_versions ${sql.insert({
            agentId: `hob${index}`,
            version,
            roleTitle,
            instructions,
            lookSeed: index,
            lookColor: "moss",
            createdAt: "2026-10-30T00:00:00.000Z",
          })}`;
        }
      }
      yield* hobIdentity;
      return {
        agents: (yield* sql<{ instructions: string }>`SELECT instructions FROM agents ORDER BY id`).map(
          (row) => row.instructions,
        ),
        versions: (yield* sql<{ instructions: string }>`
          SELECT instructions FROM agent_config_versions ORDER BY agent_id, version
        `).map((row) => row.instructions),
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0013"))), Effect.runPromise);

    const expected = [
      "Your chores, in the user's words:\nSort mail.",
      "",
      "Be brief.",
      "Water the plants.",
      "",
      hobs[5][2],
      hobs[6][2],
      hobs[7][2],
    ];
    expect(result.agents).toEqual(expected);
    expect(result.versions).toEqual(expected.flatMap((instructions) => [instructions, instructions]));
  });
});
