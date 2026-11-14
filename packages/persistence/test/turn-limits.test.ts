import { TurnLimitsStore } from "@hobbots/agents";
import { DEFAULT_TURN_LIMITS } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { TurnLimitsRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1448 (OR-005): the turn limits are kept across restarts, on SQLite and PostgreSQL alike
// (STD-TEST-006).

const run = <A, E>(effect: Effect.Effect<A, E, TurnLimitsStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(TurnLimitsRepositoryLive.pipe(Layer.provideMerge(TestDatabase))), Effect.runPromise);

describe("turn limits", () => {
  // covers OR-005
  it("[TC-PE-1448-01] reads the defaults until limits are set, then the limits last set", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* TurnLimitsStore;
        const before = yield* store.get;
        yield* store.set({ perHob: 2, perQuest: 3, perRuntime: { "claude-code": 5, codex: 1 } });
        yield* store.set({ perHob: 1, perQuest: 3, perRuntime: { "claude-code": 5, codex: 2 } });
        return { before, after: yield* store.get };
      }),
    );
    expect(result.before).toEqual(DEFAULT_TURN_LIMITS);
    expect(result.after).toEqual({ perHob: 1, perQuest: 3, perRuntime: { "claude-code": 5, codex: 2 } });
  });

  // covers OR-005
  it("[TC-PE-1448-02] gives a runtime the row does not name its default, and reads a row it cannot as the defaults", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* TurnLimitsStore;
        yield* sql`INSERT INTO turn_limits ${sql.insert({
          id: 1,
          per_hob: 2,
          per_quest: 2,
          per_runtime: JSON.stringify({ codex: 3 }),
          updated_at: "2026-11-13T00:00:00.000Z",
        })}`;
        const partial = yield* store.get;
        yield* sql`UPDATE turn_limits SET per_hob = 0`;
        const unreadable = yield* store.get;
        return { partial, unreadable };
      }),
    );
    expect(result.partial).toEqual({
      perHob: 2,
      perQuest: 2,
      perRuntime: { "claude-code": DEFAULT_TURN_LIMITS.perRuntime["claude-code"], codex: 3 },
    });
    expect(result.unreadable).toEqual(DEFAULT_TURN_LIMITS);
  });
});
