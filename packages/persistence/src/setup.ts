import { InstallationSettings } from "@hobbots/agents";
import { InstallationSetup, type RuntimeKind, type SafetyPreset } from "@hobbots/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/** A partial change to the setup; missing fields keep their stored value. Setup cannot be reopened. */
export interface SetupChange {
  readonly completed?: true;
  readonly safetyPreset?: SafetyPreset;
  readonly approvedFolders?: ReadonlyArray<string>;
  readonly connectedProviders?: ReadonlyArray<RuntimeKind>;
}

// `completed` is stored as 0 or 1, the folders and providers as JSON arrays (migrations 0004, 0006).
const fromRow = (row: {
  readonly completed: unknown;
  readonly safetyPreset: unknown;
  readonly approvedFolders: unknown;
  readonly connectedProviders: unknown;
}) => ({
  completed: Number(row.completed) === 1,
  safetyPreset: row.safetyPreset,
  approvedFolders: JSON.parse(String(row.approvedFolders)),
  connectedProviders: JSON.parse(String(row.connectedProviders)),
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
  /** The repository, which also gives the use cases the installation's settings. */
  static readonly layer = Layer.effect(
    InstallationSettings,
    Effect.map(SetupRepository, (setup) => InstallationSettings.of({ get: setup.get })),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
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
                connectedProviders: unknown;
              }>`SELECT completed, safety_preset, approved_folders, connected_providers FROM installation_setup WHERE id = 1`.pipe(
                Effect.map((rows) => rows.map(fromRow)),
              ),
          });
          const get = find().pipe(Effect.orDie);

          // Writes only the columns the change names, so concurrent changes to other fields survive,
          // and reads the row back in the same transaction.
          const update = (change: SetupChange) =>
            Effect.gen(function* () {
              const columns: Record<string, string | number> = {};
              if (change.completed) columns.completed = 1;
              if (change.safetyPreset !== undefined) columns.safety_preset = change.safetyPreset;
              if (change.approvedFolders !== undefined)
                columns.approved_folders = JSON.stringify(change.approvedFolders);
              if (change.connectedProviders !== undefined) {
                columns.connected_providers = JSON.stringify(change.connectedProviders);
              }
              if (Object.keys(columns).length > 0) {
                yield* sql`UPDATE installation_setup SET ${sql.update(columns)} WHERE id = 1`;
              }
              return yield* find();
            }).pipe(sql.withTransaction, Effect.orDie);

          return SetupRepository.of({ get, update });
        }),
      ),
    ),
  );
}
