import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, migrations } from "../src/index.ts";
import hobBrain from "../src/migrations/0005_hob_brain.ts";
import hobConfigVersions from "../src/migrations/0007_hob_config_versions.ts";
import hobStatus from "../src/migrations/0008_hob_status.ts";
import hobRetiredAt from "../src/migrations/0009_hob_retired_at.ts";
import hobRoles from "../src/migrations/0010_hob_roles.ts";
import hobIdentity from "../src/migrations/0013_hob_identity.ts";
import hobTone from "../src/migrations/0014_hob_tone.ts";
import hobPolicy from "../src/migrations/0015_hob_policy.ts";
import threadBrains from "../src/migrations/0020_thread_brains.ts";
import hobSignCommits from "../src/migrations/0021_hob_sign_commits.ts";
import threadArchivedAt from "../src/migrations/0023_thread_archived_at.ts";
import githubCharm from "../src/migrations/0027_github_charm.ts";
import backpackBlockers from "../src/migrations/0029_backpack_blockers.ts";
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

  // covers AG-002, DP-003
  it("[TC-AG-085] removes an opening written for a title the hob had before its role changed", async () => {
    // Each hob: name, its titles from version 1 on (the last is current), and the instructions it kept.
    const hobs = [
      // Created with its own title, then given a starter role without rewriting the instructions.
      ["Fern", ["Gardener", "Writer"], "You are Fern, a hob in Hobbots. Your role is Gardener.\n\nWater the plants."],
      // An own title in the old wording, then another own title.
      ["Moss", ["Guide", "Mentor"], "You are Moss, a hob in Hobbots. You are good at guide.\n\nBe gentle."],
      // A title this hob never had stays: the user may have written it.
      ["Bram", ["Writer", "Editor"], "You are Bram, a hob in Hobbots. Your role is Baker.\n\nBake."],
    ] as const;
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [index, [name, titles, instructions]] of hobs.entries()) {
        yield* sql`INSERT INTO agents ${sql.insert({
          id: `hob${index}`,
          name,
          roleTitle: titles[titles.length - 1] ?? "",
          runtime: "claude-code",
          instructions,
          lookSeed: index,
          lookColor: "moss",
          configVersion: titles.length,
          createdAt: "2026-10-30T00:00:00.000Z",
        })}`;
        for (const [at, roleTitle] of titles.entries()) {
          yield* sql`INSERT INTO agent_config_versions ${sql.insert({
            agentId: `hob${index}`,
            version: at + 1,
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

    const expected = ["Water the plants.", "Be gentle.", hobs[2][2]];
    expect(result.agents).toEqual(expected);
    expect(result.versions).toEqual(expected.flatMap((instructions) => [instructions, instructions]));
  });
});

describe("0014_hob_tone", () => {
  // covers AG-002, DP-003
  it("[TC-AG-086] gives every existing hob and version the Default voice and Balanced length", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO agent_config_versions ${sql.insert({
        agentId: "pip",
        version: 1,
        roleTitle: "Writer",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* hobTone;
      return {
        agents: yield* sql`SELECT voice, length FROM agents`,
        versions: yield* sql`SELECT voice, length FROM agent_config_versions`,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0014"))), Effect.runPromise);

    expect(result.agents).toEqual([{ voice: "default", length: "balanced" }]);
    expect(result.versions).toEqual([{ voice: "default", length: "balanced" }]);
  });

  // covers DP-003
  it("[TC-DP-051] still reads a hob event journaled before tone existed, with the default tone", async () => {
    // The AgentUpserted payload as the hub journaled it before 0014, with no voice or length.
    const before = {
      _tag: "AgentUpserted",
      agent: {
        id: "pip",
        name: "Pip",
        role: "writer",
        roleTitle: "Writer",
        sigil: "writer",
        hat: null,
        tool: null,
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        status: "active",
        retiredAt: null,
        configVersion: 1,
        createdAt: "2026-10-28T00:00:00.000Z",
        revision: 1,
      },
    };
    const database = TestDatabaseAt(migrationsBefore("0014"));
    const entries = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE event_journal_head SET sequence = 1 WHERE id = 1`;
      yield* sql`INSERT INTO event_journal ${sql.insert({
        sequence: 1,
        id: "8a1f6c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b",
        type: "AgentUpserted",
        schemaVersion: 1,
        occurredAt: "2026-10-28T00:00:00.000Z",
        agentId: "pip",
        payload: JSON.stringify(before),
      })}`;
      yield* hobTone;
      return yield* (yield* EventJournal).readAfter(0);
    }).pipe(Effect.provide(EventJournal.layer.pipe(Layer.provideMerge(database))), Effect.scoped, Effect.runPromise);

    expect(entries.map((e) => e.payload)).toMatchObject([
      { _tag: "AgentUpserted", agent: { id: "pip", voice: "default", length: "balanced" } },
    ]);
  });
});

describe("0015_hob_policy", () => {
  // covers AG-002, AG-004, DP-003
  it("[TC-AG-089] gives every existing hob and version an empty policy: no own or hidden folders, no overrides", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO agent_config_versions ${sql.insert({
        agentId: "pip",
        version: 1,
        roleTitle: "Writer",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* hobPolicy;
      return {
        agents: yield* sql`SELECT own_folders, hidden_shared_folders, policy_overrides FROM agents`,
        versions: yield* sql`SELECT own_folders, hidden_shared_folders, policy_overrides FROM agent_config_versions`,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0015"))), Effect.runPromise);

    const empty = { ownFolders: "[]", hiddenSharedFolders: "[]", policyOverrides: "{}" };
    expect(result.agents).toEqual([empty]);
    expect(result.versions).toEqual([empty]);
  });

  // covers DP-003
  it("[TC-DP-034] still reads a hob event journaled before policies existed, with the empty policy", async () => {
    // The AgentUpserted payload as the hub journaled it before 0015, with no policy.
    const before = {
      _tag: "AgentUpserted",
      agent: {
        id: "pip",
        name: "Pip",
        role: "writer",
        roleTitle: "Writer",
        sigil: "writer",
        hat: null,
        tool: null,
        voice: "default",
        length: "balanced",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        status: "active",
        retiredAt: null,
        configVersion: 1,
        createdAt: "2026-10-28T00:00:00.000Z",
        revision: 1,
      },
    };
    const database = TestDatabaseAt(migrationsBefore("0015"));
    const entries = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE event_journal_head SET sequence = 1 WHERE id = 1`;
      yield* sql`INSERT INTO event_journal ${sql.insert({
        sequence: 1,
        id: "5d2e7f1a-4c3b-4a6d-8e9f-0a1b2c3d4e5f",
        type: "AgentUpserted",
        schemaVersion: 1,
        occurredAt: "2026-10-28T00:00:00.000Z",
        agentId: "pip",
        payload: JSON.stringify(before),
      })}`;
      yield* hobPolicy;
      return yield* (yield* EventJournal).readAfter(0);
    }).pipe(Effect.provide(EventJournal.layer.pipe(Layer.provideMerge(database))), Effect.scoped, Effect.runPromise);

    expect(entries.map((e) => e.payload)).toMatchObject([
      {
        _tag: "AgentUpserted",
        agent: { id: "pip", policy: { ownFolders: [], hiddenSharedFolders: [], overrides: {} } },
      },
    ]);
  });
});

describe("0020_thread_brains", () => {
  // covers DP-003, RT-001
  it("[TC-DP-035] moves each thread's Claude Code session into its sessions and records each reply's brain", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO agent_config_versions ${sql.insert({
        agentId: "pip",
        version: 1,
        roleTitle: "Writer",
        model: "sonnet",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      for (const [id, session] of [
        ["bound", "s1"],
        ["fresh", null],
      ] as const) {
        yield* sql`INSERT INTO threads ${sql.insert({
          id,
          agentId: "pip",
          title: id,
          runtimeSessionId: session,
          createdAt: "2026-10-28T00:00:00.000Z",
          updatedAt: "2026-10-28T00:00:00.000Z",
        })}`;
      }
      const messages = [
        { id: "u1", role: "user", status: "complete", configVersion: null, seq: 1 },
        { id: "a1", role: "assistant", status: "complete", configVersion: 1, seq: 2 },
        { id: "q1", role: "user", status: "queued", configVersion: null, seq: 3 },
      ];
      for (const m of messages) {
        yield* sql`INSERT INTO messages ${sql.insert({
          ...m,
          threadId: "bound",
          content: m.id,
          createdAt: "2026-10-28T00:00:00.000Z",
        })}`;
      }
      yield* threadBrains;
      return {
        threads: yield* sql`SELECT id, sessions, brain FROM threads ORDER BY id`,
        messages: yield* sql`SELECT id, runtime, model FROM messages ORDER BY seq`,
        versions: yield* sql`SELECT runtime FROM agent_config_versions`,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0020"))), Effect.runPromise);

    expect(result.threads).toEqual([
      {
        id: "bound",
        sessions: JSON.stringify([{ runtime: "claude-code", sessionId: "s1", seenThrough: "a1" }]),
        brain: null,
      },
      { id: "fresh", sessions: "[]", brain: null },
    ]);
    expect(result.messages).toEqual([
      { id: "u1", runtime: null, model: null },
      { id: "a1", runtime: "claude-code", model: "sonnet" },
      { id: "q1", runtime: null, model: null },
    ]);
    expect(result.versions).toEqual([{ runtime: "claude-code" }]);
  });

  // covers DP-003
  it("[TC-DP-036] still reads a thread event journaled before brains existed, with no sessions and no brain", async () => {
    const before = {
      _tag: "ThreadUpserted",
      thread: {
        id: "t1",
        agentId: "pip",
        title: "Hello",
        runtimeSessionId: "s1",
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
        revision: 1,
      },
    };
    const database = TestDatabaseAt(migrationsBefore("0020"));
    const entries = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE event_journal_head SET sequence = 1 WHERE id = 1`;
      yield* sql`INSERT INTO event_journal ${sql.insert({
        sequence: 1,
        id: "0b6f2c1e-7a3d-4e8f-9b0a-1c2d3e4f5a6b",
        type: "ThreadUpserted",
        schemaVersion: 1,
        occurredAt: "2026-10-28T00:00:00.000Z",
        threadId: "t1",
        payload: JSON.stringify(before),
      })}`;
      yield* threadBrains;
      return yield* (yield* EventJournal).readAfter(0);
    }).pipe(Effect.provide(EventJournal.layer.pipe(Layer.provideMerge(database))), Effect.scoped, Effect.runPromise);

    expect(entries.map((e) => e.payload)).toMatchObject([
      { _tag: "ThreadUpserted", thread: { id: "t1", sessions: [], brain: null } },
    ]);
  });
});

describe("0021_hob_sign_commits", () => {
  // covers AG-004, DP-003
  it("[TC-DP-037] leaves every existing hob and version unsigned", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO agent_config_versions ${sql.insert({
        agentId: "pip",
        version: 1,
        roleTitle: "Writer",
        model: "sonnet",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* hobSignCommits;
      return {
        agents: yield* sql`SELECT sign_commits FROM agents`,
        versions: yield* sql`SELECT sign_commits FROM agent_config_versions`,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0021"))), Effect.runPromise);

    expect(result.agents.map((row) => Number(row.signCommits))).toEqual([0]);
    expect(result.versions.map((row) => Number(row.signCommits))).toEqual([0]);
  });
});

describe("0023_thread_archived_at", () => {
  // covers CH-009, DP-003
  it("[TC-DP-040] keeps every existing thread live, and still reads thread events journaled before archiving", async () => {
    const before = {
      _tag: "ThreadUpserted",
      thread: {
        id: "t1",
        agentId: "pip",
        title: "Hello",
        sessions: [],
        brain: null,
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
        revision: 1,
      },
    };
    const database = TestDatabaseAt(migrationsBefore("0023"));
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO threads ${sql.insert({
        id: "t1",
        agentId: "pip",
        title: "Hello",
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`UPDATE event_journal_head SET sequence = 1 WHERE id = 1`;
      yield* sql`INSERT INTO event_journal ${sql.insert({
        sequence: 1,
        id: "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",
        type: "ThreadUpserted",
        schemaVersion: 2,
        occurredAt: "2026-10-28T00:00:00.000Z",
        threadId: "t1",
        payload: JSON.stringify(before),
      })}`;
      yield* threadArchivedAt;
      return {
        threads: yield* sql`SELECT archived_at FROM threads`,
        entries: yield* (yield* EventJournal).readAfter(0),
      };
    }).pipe(Effect.provide(EventJournal.layer.pipe(Layer.provideMerge(database))), Effect.scoped, Effect.runPromise);

    expect(result.threads).toEqual([{ archivedAt: null }]);
    expect(result.entries.map((e) => e.payload)).toMatchObject([
      { _tag: "ThreadUpserted", thread: { id: "t1", archivedAt: null } },
    ]);
  });
});

describe("0027_github_charm", () => {
  // covers DP-003, PE-002
  it("[TC-PE-145] keeps the GitHub Charm for every existing hob and version, and holds one account with no token", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* sql`INSERT INTO agent_config_versions ${sql.insert({
        agentId: "pip",
        version: 1,
        roleTitle: "Writer",
        model: "sonnet",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      yield* githubCharm;
      yield* sql`INSERT INTO github_account (id, source, login, connected_at) VALUES (1, 'app', 'pip', 'now')`;
      const second = yield* Effect.result(
        sql`INSERT INTO github_account (id, source, login, connected_at) VALUES (2, 'gh', 'other', 'now')`,
      );
      return {
        agents: yield* sql`SELECT github_charm FROM agents`,
        versions: yield* sql`SELECT github_charm FROM agent_config_versions`,
        columns: Object.keys((yield* sql`SELECT * FROM github_account`)[0] ?? {}).sort(),
        second: second._tag,
      };
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0027"))), Effect.runPromise);

    expect(result.agents.map((row) => Number(row.githubCharm))).toEqual([1]);
    expect(result.versions.map((row) => Number(row.githubCharm))).toEqual([1]);
    expect(result.columns).toEqual(["connectedAt", "id", "login", "source"]);
    expect(result.second).toBe("Failure");
  });
});

describe("0029_backpack_blockers", () => {
  // covers DP-003, IN-007
  it("[TC-IN-095] gives every item that failed before it a blocker to retry, counting its deliveries, and none to the rest", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "pip",
        name: "Pip",
        roleTitle: "Writer",
        runtime: "claude-code",
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        createdAt: "2026-10-28T00:00:00.000Z",
      })}`;
      const item = (id: string, state: string, error: string | null) =>
        sql`INSERT INTO backpack_items ${sql.insert({
          id,
          recipientId: "pip",
          kind: "message",
          actionable: 1,
          priority: 1,
          state,
          dedupeKey: id,
          payload: JSON.stringify({ _tag: "message", senderId: null, text: "Hi" }),
          error,
          createdAt: "2026-10-28T00:00:00.000Z",
          updatedAt: "2026-10-29T00:00:00.000Z",
          recordedSequence: 1,
        })}`;
      yield* item("failed", "failed", "Delivered 2 times, and every turn ended early.");
      yield* item("waiting", "pending", null);
      for (const number of [1, 2]) {
        yield* sql`INSERT INTO backpack_deliveries ${sql.insert({
          itemId: "failed",
          number,
          claimToken: number,
          target: "thread:t1",
          turnId: `turn-${number}`,
          deliveredAt: "2026-10-28T00:00:00.000Z",
        })}`;
      }
      yield* backpackBlockers;
      return yield* sql`SELECT * FROM backpack_blockers`;
    }).pipe(Effect.provide(TestDatabaseAt(migrationsBefore("0029"))), Effect.runPromise);

    expect(
      result.map((row) => ({ ...row, number: Number(row.number), afterDeliveries: Number(row.afterDeliveries) })),
    ).toEqual([
      {
        itemId: "failed",
        number: 1,
        reason: "retries-exhausted",
        nextAction: "retry",
        error: "Delivered 2 times, and every turn ended early.",
        afterDeliveries: 2,
        raisedAt: "2026-10-29T00:00:00.000Z",
        decision: null,
        decidedAt: null,
      },
    ]);
  });
});
