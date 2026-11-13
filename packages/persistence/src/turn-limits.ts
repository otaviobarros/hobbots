import { TurnLimitsStore } from "@hobbots/agents";
import { DEFAULT_TURN_LIMITS, TurnLimits } from "@hobbots/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

interface Row {
  readonly perHob: unknown;
  readonly perQuest: unknown;
  readonly perRuntime: unknown;
}

const decodeLimits = Schema.decodeUnknownEffect(TurnLimits);

/**
 * The turn limits (#1448), one row on SQLite and PostgreSQL (migration 0115). Without a row the hub
 * runs with the defaults. A runtime the stored row does not name, as one a later Hobbots added,
 * takes its default.
 */
export const TurnLimitsRepositoryLive = Layer.effect(
  TurnLimitsStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = Effect.gen(function* () {
      const [row] = yield* sql<Row>`SELECT per_hob, per_quest, per_runtime FROM turn_limits WHERE id = 1`;
      if (row === undefined) return DEFAULT_TURN_LIMITS;
      const perRuntime = yield* Effect.try(() => JSON.parse(String(row.perRuntime)) as unknown);
      return yield* decodeLimits({
        perHob: Number(row.perHob),
        perQuest: Number(row.perQuest),
        perRuntime: { ...DEFAULT_TURN_LIMITS.perRuntime, ...(typeof perRuntime === "object" ? perRuntime : {}) },
      });
    }).pipe(
      // Limits this Hobbots cannot read hold as the defaults.
      Effect.catchTag("SchemaError", () => Effect.succeed(DEFAULT_TURN_LIMITS)),
      Effect.catchTag("UnknownError", () => Effect.succeed(DEFAULT_TURN_LIMITS)),
      Effect.orDie,
    );
    const set = (limits: TurnLimits) =>
      Effect.gen(function* () {
        const columns = {
          per_hob: limits.perHob,
          per_quest: limits.perQuest,
          per_runtime: JSON.stringify(limits.perRuntime),
          updated_at: DateTime.formatIso(yield* DateTime.now),
        };
        yield* sql`INSERT INTO turn_limits ${sql.insert({ id: 1, ...columns })}
          ON CONFLICT (id) DO UPDATE SET ${sql.update(columns)}`;
      }).pipe(Effect.orDie);
    return TurnLimitsStore.of({ get, set });
  }),
);
