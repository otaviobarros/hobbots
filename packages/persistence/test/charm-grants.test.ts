import { HobbotsRepository } from "@hobbots/agents";
import { AgentId, heldCharms } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import charmGrants from "../src/migrations/0076_charm_grants.ts";
import { TestDatabaseAt } from "../src/testing.ts";

const now = "2026-11-07T00:00:00.000Z";

/** The migrations that ran before 0076, which leave the GitHub Charm flag in place. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0076")) as typeof migrations;

/** A hob and its first configuration version, as the hub stored them before 0076, with its GitHub Charm on or off. */
const storedHob = (id: string, githubCharm: 0 | 1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = {
      roleTitle: "Guide",
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      createdAt: now,
      githubCharm,
    };
    yield* sql`INSERT INTO agents ${sql.insert({ id, name: id, runtime: "claude-code", ...fields })}`;
    yield* sql`INSERT INTO agent_config_versions ${sql.insert({ agentId: id, version: 1, model: "sonnet", ...fields })}`;
  });

describe("0076_charm_grants", () => {
  // covers DP-003, PE-002, ADR 031
  it("[TC-DP-290] turns each hob's GitHub Charm flag into its set of Charm ids, on the hob and every version", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* storedHob("pip", 1);
      yield* storedHob("rook", 0);
      yield* charmGrants;
      const repo = yield* HobbotsRepository;
      const held = (id: string) =>
        repo.findAgent(AgentId.make(id)).pipe(Effect.map((agent) => Option.map(agent, (a) => heldCharms(a.policy))));
      return {
        agents: yield* sql<{ id: string; charms: string }>`SELECT id, charms FROM agents ORDER BY id`,
        versions: yield* sql<{ agentId: string; charms: string }>`
          SELECT agent_id, charms FROM agent_config_versions ORDER BY agent_id`,
        columns: Object.keys((yield* sql`SELECT * FROM agents`)[0] ?? {}),
        pip: yield* held("pip"),
        rook: yield* held("rook"),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer).pipe(Layer.provideMerge(TestDatabaseAt(earlier))),
      ),
      Effect.runPromise,
    );

    expect(result.agents).toEqual([
      { id: "pip", charms: '["github"]' },
      { id: "rook", charms: "[]" },
    ]);
    expect(result.versions).toEqual([
      { agentId: "pip", charms: '["github"]' },
      { agentId: "rook", charms: "[]" },
    ]);
    expect(result.columns).not.toContain("githubCharm");
    // A hob with the GitHub Charm on before the migration still holds it after, and one with it off holds none.
    expect(result.pip).toEqual(Option.some(["github"]));
    expect(result.rook).toEqual(Option.some([]));
  });
});
