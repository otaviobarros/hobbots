import { SkillUpdateLog } from "@hobbots/agents";
import {
  type JournaledEvent,
  type SkillId,
  SkillUpdate,
  SkillUpdateCheck,
  type SkillUpdateProblem,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

interface Row {
  readonly skillId: string;
  readonly name: string;
  readonly sourceId: string;
  readonly base: string;
  readonly baseNumber: unknown;
  readonly hash: string;
  readonly commitSha: string | null;
  readonly label: string | null;
  readonly path: string | null;
  readonly files: string;
  readonly instructions: string;
  readonly flags: string;
  readonly state: string;
  readonly foundAt: string;
}

const decodeUpdate = Schema.decodeUnknownEffect(SkillUpdate);
const decodeCheck = Schema.decodeUnknownEffect(SkillUpdateCheck);

const fromRow = (row: Row) =>
  decodeUpdate({
    skillId: row.skillId,
    name: row.name,
    sourceId: row.sourceId,
    base: row.base,
    // PostgreSQL may read an integer as a bigint or a string; every revision number fits a number.
    baseNumber: Number(row.baseNumber),
    hash: row.hash,
    commit: row.commitSha,
    label: row.label,
    path: row.path,
    files: JSON.parse(row.files),
    instructions: JSON.parse(row.instructions),
    flags: JSON.parse(row.flags),
    state: row.state,
    foundAt: row.foundAt,
  }).pipe(Effect.orDie);

const toRow = (update: SkillUpdate) => ({
  skill_id: update.skillId,
  name: update.name,
  source_id: update.sourceId,
  base: update.base,
  base_number: update.baseNumber,
  hash: update.hash,
  commit_sha: update.commit,
  label: update.label,
  path: update.path,
  files: JSON.stringify(update.files),
  instructions: JSON.stringify(update.instructions),
  flags: JSON.stringify(update.flags),
  state: update.state,
  found_at: update.foundAt,
});

const nullOf = <A>(committed: Option.Option<A>): A | null => Option.getOrNull(committed);

/**
 * The SQL record of updates from a source (migration 0077). Each change is one transaction with the
 * journal's sequence reserved first, and a change that finds nothing to do writes and journals nothing.
 */
export const SkillUpdateLogLive = Layer.effect(
  SkillUpdateLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);

    const rowOf = (skillId: SkillId) =>
      sql<Row>`SELECT * FROM skill_updates WHERE skill_id = ${skillId}`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : fromRow(row))),
      );

    return SkillUpdateLog.of({
      // A removed skill's update is left out: it has nothing to update.
      waiting: sqlOrDie(
        sql<Row>`SELECT u.* FROM skill_updates u JOIN skills s ON s.id = u.skill_id
          WHERE u.state = 'waiting' AND s.removed_at IS NULL ORDER BY u.name`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
        ),
      ),
      get: (skillId) => sqlOrDie(rowOf(skillId)),
      found: (update) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const before = yield* rowOf(update.skillId);
            // The same upstream content found again: a waiting one keeps its review, a dismissed one stays so.
            if (before?.hash === update.hash) return null;
            const row = toRow(update);
            yield* sql`DELETE FROM skill_updates WHERE skill_id = ${update.skillId}`;
            yield* sql`INSERT INTO skill_updates ${sql.insert(row)}`;
            const events: ReadonlyArray<JournaledEvent> = [{ _tag: "SkillUpdateFound", update }];
            return { value: update, events };
          }),
        ).pipe(Effect.map(nullOf)),
      dismiss: (skillId, hash) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const [row] = yield* sql<Row>`UPDATE skill_updates SET state = 'dismissed'
              WHERE skill_id = ${skillId} AND hash = ${hash} AND state = 'waiting' RETURNING *`;
            if (row === undefined) return null;
            const update = yield* fromRow(row);
            const events: ReadonlyArray<JournaledEvent> = [{ _tag: "SkillUpdateDismissed", update }];
            return { value: update, events };
          }),
        ).pipe(Effect.map(nullOf)),
      clear: (skillId, hash) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const [row] =
              hash === undefined
                ? yield* sql<Row>`DELETE FROM skill_updates WHERE skill_id = ${skillId} RETURNING *`
                : yield* sql<Row>`DELETE FROM skill_updates
                    WHERE skill_id = ${skillId} AND hash = ${hash} RETURNING *`;
            if (row === undefined) return null;
            const cleared = yield* fromRow(row);
            const events: ReadonlyArray<JournaledEvent> = [{ _tag: "SkillUpdateCleared", skillId, hash: cleared.hash }];
            return { value: skillId, events };
          }),
        ).pipe(Effect.map(nullOf)),
      automatic: sqlOrDie(
        sql<{ readonly skillId: SkillId }>`SELECT a.skill_id FROM skill_auto_updates a
          JOIN skills s ON s.id = a.skill_id WHERE s.removed_at IS NULL ORDER BY a.skill_id`.pipe(
          Effect.map((rows) => rows.map((row) => row.skillId)),
        ),
      ),
      setAutomatic: (skillId, on) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const at = DateTime.formatIso(yield* DateTime.now);
            const changed = on
              ? yield* sql`INSERT INTO skill_auto_updates ${sql.insert({ skill_id: skillId, turned_on_at: at })}
                  ON CONFLICT (skill_id) DO NOTHING RETURNING skill_id`
              : yield* sql`DELETE FROM skill_auto_updates WHERE skill_id = ${skillId} RETURNING skill_id`;
            if (changed.length === 0) return null;
            const events: ReadonlyArray<JournaledEvent> = [{ _tag: "SkillAutoUpdateChanged", skillId, on }];
            return { value: on, events };
          }),
        ).pipe(Effect.map(nullOf)),
      lastCheck: sqlOrDie(
        sql<{ readonly checkedAt: string; readonly problems: string }>`SELECT checked_at, problems
          FROM skill_update_checks WHERE id = 1`.pipe(
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.succeed({ checkedAt: null, problems: [] })
              : decodeCheck({ checkedAt: row.checkedAt, problems: JSON.parse(row.problems) }).pipe(Effect.orDie),
          ),
        ),
      ),
      checked: (at, problems: ReadonlyArray<SkillUpdateProblem>) =>
        sqlOrDie(
          sql`INSERT INTO skill_update_checks ${sql.insert({ id: 1, checked_at: at, problems: JSON.stringify(problems) })}
            ON CONFLICT (id) DO UPDATE SET checked_at = ${at}, problems = ${JSON.stringify(problems)}`.pipe(
            Effect.asVoid,
          ),
        ),
    });
  }),
);
