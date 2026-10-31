import { HobbotsRepository } from "@hobbots/agents";
import { Agent, AgentId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { SetupRepository } from "../src/index.ts";
import installationSetup from "../src/migrations/0004_installation_setup.ts";
import connectedProviders from "../src/migrations/0006_connected_providers.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, SetupRepository.layer).pipe(Layer.provideMerge(TestDatabase));

const aldric = new Agent({
  id: AgentId.make("aldric"),
  name: "Aldric",
  roleTitle: "Guide",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 4821,
  lookColor: "violet",
  configVersion: 1,
  createdAt: "2026-10-28T00:00:00.000Z",
});

describe("SetupRepository", () => {
  // covers OP-001, PE-001
  it("[TC-OP-001] starts a new installation with setup to do and the Balanced preset", async () => {
    const setup = await Effect.gen(function* () {
      return yield* (yield* SetupRepository).get;
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect({ ...setup }).toEqual({
      completed: false,
      safetyPreset: "balanced",
      approvedFolders: [],
      connectedProviders: [],
    });
  });

  // covers OP-001, DP-003
  it("[TC-OP-002] marks an installation that already has hobs as set up when it migrates", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Back to the schema before migration 0004, with the hob earlier versions seeded.
      yield* sql`DROP TABLE installation_setup`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (4, 6)`;
      yield* (yield* HobbotsRepository).insertAgent(aldric);
      yield* installationSetup;
      yield* connectedProviders;
      return {
        setup: yield* (yield* SetupRepository).get,
        hobs: yield* (yield* HobbotsRepository).listAgents,
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect({ ...result.setup }).toEqual({
      completed: true,
      safetyPreset: "balanced",
      approvedFolders: [],
      connectedProviders: ["claude-code"],
    });
    expect(result.hobs.map((hob) => hob.name)).toEqual(["Aldric"]);
  });

  // covers OP-001, PE-001
  it("[TC-OP-003] keeps fields a change leaves out and stores the folders in order", async () => {
    const result = await Effect.gen(function* () {
      const setup = yield* SetupRepository;
      const first = yield* setup.update({ safetyPreset: "careful", approvedFolders: ["/b", "/a"] });
      const second = yield* setup.update({ completed: true });
      return { first, second, stored: yield* setup.get };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect({ ...result.first }).toEqual({
      completed: false,
      safetyPreset: "careful",
      approvedFolders: ["/b", "/a"],
      connectedProviders: [],
    });
    expect({ ...result.second }).toEqual({
      completed: true,
      safetyPreset: "careful",
      approvedFolders: ["/b", "/a"],
      connectedProviders: [],
    });
    expect({ ...result.stored }).toEqual({ ...result.second });
  });

  // covers OP-001, DP-003
  it("[TC-OP-007] keeps every field when changes to different fields arrive at once", async () => {
    const stored = await Effect.gen(function* () {
      const setup = yield* SetupRepository;
      yield* Effect.all(
        [
          setup.update({ safetyPreset: "careful" }),
          setup.update({ completed: true }),
          setup.update({ approvedFolders: ["/a"] }),
          setup.update({ safetyPreset: "careful" }),
          setup.update({ approvedFolders: ["/a"] }),
        ],
        { concurrency: "unbounded" },
      );
      return yield* setup.get;
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect({ ...stored }).toEqual({
      completed: true,
      safetyPreset: "careful",
      approvedFolders: ["/a"],
      connectedProviders: [],
    });
  });

  // covers OP-001, DP-003
  it("[TC-OP-012] keeps an unfinished setup's providers empty when it migrates, then stores the user's choice", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Back to the schema before migration 0006, with setup still to do.
      yield* sql`ALTER TABLE installation_setup DROP COLUMN connected_providers`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 6`;
      yield* connectedProviders;
      const setup = yield* SetupRepository;
      const migrated = yield* setup.get;
      yield* setup.update({ connectedProviders: ["claude-code"] });
      return { migrated, stored: yield* setup.get };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.migrated.connectedProviders).toEqual([]);
    expect(result.stored.connectedProviders).toEqual(["claude-code"]);
  });
});
