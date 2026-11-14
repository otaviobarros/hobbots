import { InstallationSettings, SettingHistory } from "@hobbots/agents";
import {
  type Actor,
  type Committed,
  InstallationSetup,
  type RuntimeKind,
  type SafetyPreset,
  SettingChange,
  type SummoningForEveryHob,
  settingDiffs,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";

/** A partial change to the setup; missing fields keep their stored value. Setup cannot be reopened. */
export interface SetupChange {
  readonly completed?: true;
  readonly safetyPreset?: SafetyPreset;
  readonly approvedFolders?: ReadonlyArray<string>;
  readonly connectedProviders?: ReadonlyArray<RuntimeKind>;
  /** The Summoning Charm for every hob you made, or null to turn it off (ADR 034). */
  readonly summoningForEveryHob?: SummoningForEveryHob | null;
}

// `completed` is stored as 0 or 1, the folders and providers as JSON arrays (migrations 0004, 0006),
// and "Summoning for every hob" as JSON text, or null for off (migration 0083).
const fromRow = (row: {
  readonly completed: unknown;
  readonly safetyPreset: unknown;
  readonly approvedFolders: unknown;
  readonly connectedProviders: unknown;
  readonly summoningEveryHob: unknown;
}) => ({
  completed: Number(row.completed) === 1,
  safetyPreset: row.safetyPreset,
  approvedFolders: JSON.parse(String(row.approvedFolders)),
  connectedProviders: JSON.parse(String(row.connectedProviders)),
  summoningForEveryHob: row.summoningEveryHob == null ? null : JSON.parse(String(row.summoningEveryHob)),
});

const encodeChange = Schema.encodeSync(SettingChange);
const decodeChanges = Schema.decodeUnknownEffect(Schema.Array(SettingChange));

interface ChangeRow {
  readonly id: string;
  readonly actor: string;
  readonly setting: string;
  readonly beforeValue: string;
  readonly afterValue: string;
  readonly createdAt: string;
}

const changeOf = (row: ChangeRow) => ({
  id: row.id,
  at: row.createdAt,
  actor: JSON.parse(row.actor),
  diff: { setting: row.setting, before: JSON.parse(row.beforeValue), after: JSON.parse(row.afterValue) },
});

/** Every change to an authority setting made at or after `since`, an ISO time, newest first. */
export const settingChangesSince = (sql: SqlClient.SqlClient, since: string) =>
  sql<ChangeRow>`SELECT * FROM setting_changes WHERE created_at >= ${since} ORDER BY revision DESC`.pipe(
    Effect.flatMap((rows) => decodeChanges(rows.map(changeOf))),
    Effect.orDie,
  );

/** The installation's setup state; migration 0004 creates its single row. */
export class SetupRepository extends Context.Service<
  SetupRepository,
  {
    readonly get: Effect.Effect<InstallationSetup>;
    /**
     * Applies the change made `by` someone and returns the setup as stored. Each authority setting
     * whose value it changes (the preset, the shared folders, "Summoning for every hob") is kept as a
     * setting change and journaled as `SettingChanged` in the same transaction (#1357, ADR 013).
     */
    readonly update: (change: SetupChange, by: Actor) => Effect.Effect<Committed<InstallationSetup>>;
    /** The changes to authority settings, newest first, at most `limit`. */
    readonly changes: (limit: number) => Effect.Effect<ReadonlyArray<SettingChange>>;
  }
>()("@hobbots/persistence/SetupRepository") {
  /** The repository, which also gives the use cases the installation's settings and their history. */
  static readonly layer = Layer.mergeAll(
    Layer.effect(
      InstallationSettings,
      Effect.map(SetupRepository, (setup) => InstallationSettings.of({ get: setup.get })),
    ),
    Layer.effect(
      SettingHistory,
      Effect.map(SetupRepository, (setup) => SettingHistory.of({ latest: setup.changes })),
    ),
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
                summoningEveryHob: unknown;
              }>`SELECT completed, safety_preset, approved_folders, connected_providers, summoning_every_hob FROM installation_setup WHERE id = 1`.pipe(
                Effect.map((rows) => rows.map(fromRow)),
              ),
          });
          const get = find().pipe(Effect.orDie);

          const journaledChange = makeJournaledChange(sql);

          // Writes only the columns the change names, so concurrent changes to other fields survive,
          // and reads the row back in the same transaction, with the row as it was before, so each
          // authority setting it changed is recorded once with its value before and after.
          const update = (change: SetupChange, by: Actor) =>
            journaledChange((first) =>
              Effect.gen(function* () {
                const before = yield* find();
                const columns: Record<string, string | number | null> = {};
                if (change.completed) columns.completed = 1;
                if (change.safetyPreset !== undefined) columns.safety_preset = change.safetyPreset;
                if (change.approvedFolders !== undefined)
                  columns.approved_folders = JSON.stringify(change.approvedFolders);
                if (change.connectedProviders !== undefined) {
                  columns.connected_providers = JSON.stringify(change.connectedProviders);
                }
                if (change.summoningForEveryHob !== undefined) {
                  columns.summoning_every_hob =
                    change.summoningForEveryHob === null ? null : JSON.stringify(change.summoningForEveryHob);
                }
                if (Object.keys(columns).length > 0) {
                  yield* sql`UPDATE installation_setup SET ${sql.update(columns)} WHERE id = 1`;
                }
                const after = yield* find();
                const at = DateTime.formatIso(yield* DateTime.now);
                const recorded = settingDiffs(before, after).map(
                  (diff): SettingChange => ({ id: crypto.randomUUID(), at, actor: by, diff }),
                );
                for (const [index, settingChange] of recorded.entries()) {
                  const encoded = encodeChange(settingChange);
                  yield* sql`INSERT INTO setting_changes ${sql.insert({
                    id: encoded.id,
                    revision: first + index,
                    setting: encoded.diff.setting,
                    actor: JSON.stringify(encoded.actor),
                    before_value: JSON.stringify(encoded.diff.before),
                    after_value: JSON.stringify(encoded.diff.after),
                    created_at: encoded.at,
                  })}`;
                }
                return {
                  value: after,
                  events: recorded.map((settingChange) => ({ _tag: "SettingChanged" as const, change: settingChange })),
                };
              }),
            ).pipe(Effect.orDie);

          const decoded = (rows: ReadonlyArray<ChangeRow>) => decodeChanges(rows.map(changeOf)).pipe(Effect.orDie);
          const changes = (limit: number) =>
            sql<ChangeRow>`SELECT * FROM setting_changes ORDER BY revision DESC LIMIT ${limit}`.pipe(
              Effect.orDie,
              Effect.flatMap(decoded),
            );
          return SetupRepository.of({ get, update, changes });
        }),
      ),
    ),
  );
}
