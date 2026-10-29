import { InstallationSetup, type SafetyPreset } from "@hobbots/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/** A partial change to the setup; missing fields keep their stored value. */
export interface SetupChange {
  readonly completed?: boolean;
  readonly safetyPreset?: SafetyPreset;
  readonly approvedFolders?: ReadonlyArray<string>;
}

// `completed` is stored as 0 or 1 and the folders as a JSON array (see migration 0004).
const fromRow = (row: {
  readonly completed: unknown;
  readonly safetyPreset: unknown;
  readonly approvedFolders: unknown;
}) => ({
  completed: Number(row.completed) === 1,
  safetyPreset: row.safetyPreset,
  approvedFolders: JSON.parse(String(row.approvedFolders)),
});

/** The installation's setup state; migration 0004 creates its single row. */
export class SetupRepository extends Context.Service<
  SetupRepository,
  {
    readonly get: Effect.Effect<InstallationSetup>;
    /** Applies the change and returns the setup as stored. */
    readonly update: (change: SetupChange) => Effect.Effect<InstallationSetup>;
  }
>()("@hobbots/persistence/SetupRepository") {
  static readonly layer = Layer.effect(
    SetupRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const find = SqlSchema.findOne({
        Request: Schema.Void,
        Result: InstallationSetup,
        execute: () =>
          sql<{
            completed: unknown;
            safetyPreset: unknown;
            approvedFolders: unknown;
          }>`SELECT completed, safety_preset, approved_folders FROM installation_setup WHERE id = 1`.pipe(
            Effect.map((rows) => rows.map(fromRow)),
          ),
      });
      const get = find().pipe(Effect.orDie);

      const update = (change: SetupChange) =>
        Effect.gen(function* () {
          const current = yield* find();
          const next = new InstallationSetup({ ...current, ...change });
          yield* sql`UPDATE installation_setup SET ${sql.update({
            completed: next.completed ? 1 : 0,
            safety_preset: next.safetyPreset,
            approved_folders: JSON.stringify(next.approvedFolders),
          })} WHERE id = 1`;
          return next;
        }).pipe(sql.withTransaction, Effect.orDie);

      return SetupRepository.of({ get, update });
    }),
  );
}
