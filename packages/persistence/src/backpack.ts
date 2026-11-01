import {
  type BackpackItem,
  type BackpackItemId,
  BackpackItemMissing,
  BackpackItemUnclaimable,
  type BackpackStep,
  backpackStep,
  IllegalBackpackTransition,
  type JournaledEvent,
  StaleBackpackClaim,
} from "@hobbots/domain";
import { Backpack, type BackpackScope, type HeldClaim } from "@hobbots/inbox";
import { DateTime, Duration, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { dispositionColumn, makeItemReads } from "./backpack-rows.ts";
import { makeJournaledChange } from "./journal.ts";

/**
 * Leases are timed by the database's clock, so every hub process that shares a database agrees on
 * when one runs out (ADR 019). Times are ISO 8601 text to the millisecond, as the app writes them.
 */
const makeDatabaseClock = (sql: SqlClient.SqlClient) => {
  /** The time `lease` from now. */
  const until = (lease: Duration.Input) => {
    const seconds = Duration.toMillis(lease) / 1000;
    return sql.onDialectOrElse({
      pg: () =>
        sql`to_char((clock_timestamp() + make_interval(secs => ${seconds}::double precision)) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      orElse: () => sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`+${seconds} seconds`})`,
    });
  };
  /** Whether the row's lease is still running. */
  const leaseLive = sql.onDialectOrElse({
    pg: () => sql.literal("lease_expires_at::timestamptz > clock_timestamp()"),
    orElse: () => sql.literal("lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
  });
  return { until, leaseLive };
};

/** Why a write under a claim changed nothing: no such item, a claim that no longer holds, or a step its state forbids. */
const refusal = (
  row:
    | {
        readonly state: string;
        readonly claimOwner: string | null;
        readonly claimToken: unknown;
        readonly live: unknown;
      }
    | undefined,
  itemId: BackpackItemId,
  held: HeldClaim,
  step: BackpackStep,
) => {
  if (row === undefined) return new BackpackItemMissing({ itemId });
  const holds = row.claimOwner === held.owner && Number(row.claimToken) === held.token && Number(row.live) === 1;
  if (!holds) return new StaleBackpackClaim({ itemId, token: held.token });
  return new IllegalBackpackTransition({ itemId, from: row.state as BackpackItem["state"], step });
};

/** The SQL backpack, for SQLite and PostgreSQL (migration 0026, ADR 019). */
export const BackpackLive = Layer.effect(
  Backpack,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);
    const reads = makeItemReads(sql);
    const clock = makeDatabaseClock(sql);
    const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    /** The item as the change left it, announced with the change's sequence. */
    const changed = (itemId: BackpackItemId) =>
      reads.item(itemId).pipe(
        Effect.flatMap((item) =>
          item === undefined ? Effect.die(new Error(`Backpack item ${itemId} vanished`)) : Effect.succeed(item),
        ),
        Effect.map((item) => ({ value: item, events: [{ _tag: "BackpackItemChanged", item } as const] })),
      );

    /** Explains a write that matched no row, inside its transaction, so it rolls back. */
    const refuse = (itemId: BackpackItemId, held: HeldClaim, step: BackpackStep) =>
      sql<{
        readonly state: string;
        readonly claimOwner: string | null;
        readonly claimToken: unknown;
        readonly live: unknown;
      }>`
        SELECT state, claim_owner, claim_token, CASE WHEN ${clock.leaseLive} THEN 1 ELSE 0 END AS live
        FROM backpack_items WHERE id = ${itemId}`.pipe(
        Effect.flatMap(([row]) => Effect.fail(refusal(row, itemId, held, step))),
      );

    /**
     * Takes one step under a claim. The claim's owner, its fencing token, its lease by the
     * database's clock and the step's starting states are checked in the one conditional update
     * that makes the change; when any fails, nothing changes. `ends` ends the claim with the step, and
     * `also` writes what else the step records, such as its delivery.
     */
    const guarded = (
      itemId: BackpackItemId,
      held: HeldClaim,
      step: BackpackStep,
      options: {
        readonly ends?: boolean;
        readonly columns?: Record<string, string | null>;
        readonly also?: Effect.Effect<void, SqlError.SqlError>;
      } = {},
    ) =>
      change((revision) =>
        Effect.gen(function* () {
          const { from, to } = backpackStep(step);
          const columns = {
            state: to,
            updated_at: yield* isoNow,
            revision,
            ...(options.ends === true ? { claim_owner: null, lease_expires_at: null } : {}),
            ...options.columns,
          };
          const updated = yield* sql`UPDATE backpack_items SET ${sql.update(columns)}
            WHERE id = ${itemId} AND claim_owner = ${held.owner} AND claim_token = ${held.token}
              AND ${clock.leaseLive} AND ${sql.in("state", from)}
            RETURNING id`;
          if (updated.length === 0) return yield* refuse(itemId, held, step);
          if (options.also !== undefined) yield* options.also;
          return yield* changed(itemId);
        }),
      );

    const claim: Backpack["Service"]["claim"] = (itemId, owner, lease) =>
      change((revision) =>
        Effect.gen(function* () {
          const updated = yield* sql`UPDATE backpack_items SET claim_owner = ${owner}, claim_token = claim_token + 1,
              lease_expires_at = ${clock.until(lease)}, updated_at = ${yield* isoNow}, revision = ${revision}
            WHERE id = ${itemId} AND state = 'pending' AND claim_owner IS NULL
            RETURNING id`;
          if (updated.length === 0) {
            const [row] = yield* sql<{ readonly state: string }>`SELECT state FROM backpack_items WHERE id = ${itemId}`;
            if (row === undefined) return yield* new BackpackItemMissing({ itemId });
            return yield* new BackpackItemUnclaimable({
              itemId,
              reason: row.state === "pending" ? "claimed" : "not-pending",
            });
          }
          return yield* changed(itemId);
        }),
      );

    const renew: Backpack["Service"]["renew"] = (itemId, held, lease) =>
      change((revision) =>
        Effect.gen(function* () {
          const updated = yield* sql`UPDATE backpack_items SET lease_expires_at = ${clock.until(lease)},
              updated_at = ${yield* isoNow}, revision = ${revision}
            WHERE id = ${itemId} AND claim_owner = ${held.owner} AND claim_token = ${held.token} AND ${clock.leaseLive}
            RETURNING id`;
          // A claim that holds can always be renewed, so this refuses a stale one.
          if (updated.length === 0) return yield* refuse(itemId, held, "deliver");
          return yield* changed(itemId);
        }),
      );

    const deliver: Backpack["Service"]["deliver"] = (itemId, held, delivery) =>
      isoNow.pipe(
        Effect.flatMap((at) =>
          guarded(itemId, held, "deliver", {
            also: sql`INSERT INTO backpack_deliveries
                (item_id, number, claim_token, target, turn_id, delivered_at, acknowledged_session_id, acknowledged_at)
              SELECT ${itemId}, COALESCE(MAX(number), 0) + 1, ${held.token}, ${delivery.target}, ${delivery.turnId}, ${at}, NULL, NULL
              FROM backpack_deliveries WHERE item_id = ${itemId}`.pipe(Effect.asVoid),
          }),
        ),
      );

    const acknowledge: Backpack["Service"]["acknowledge"] = (itemId, held, sessionId) =>
      isoNow.pipe(
        Effect.flatMap((at) =>
          guarded(itemId, held, "acknowledge", {
            also: sql`UPDATE backpack_deliveries SET acknowledged_session_id = ${sessionId}, acknowledged_at = ${at}
              WHERE item_id = ${itemId}
                AND number = (SELECT MAX(number) FROM backpack_deliveries WHERE item_id = ${itemId})`.pipe(
              Effect.asVoid,
            ),
          }),
        ),
      );

    const expireClaims: Backpack["Service"]["expireClaims"] = (options = {}) =>
      change((first) =>
        Effect.gen(function* () {
          const lapsed = options.all === true ? sql.literal("1 = 1") : sql`NOT (${clock.leaseLive})`;
          const held = yield* sql<{ readonly id: BackpackItemId }>`SELECT id FROM backpack_items
            WHERE claim_owner IS NOT NULL AND ${lapsed} ORDER BY id`;
          const at = yield* isoNow;
          const events: Array<JournaledEvent> = [];
          const items: Array<BackpackItem> = [];
          for (const [index, { id }] of held.entries()) {
            // The claim ends without its owner: its token rises, and a turn's item goes back to pending.
            yield* sql`UPDATE backpack_items SET claim_owner = NULL, lease_expires_at = NULL,
                claim_token = claim_token + 1, updated_at = ${at}, revision = ${first + index},
                state = CASE WHEN state IN ('delivered', 'acknowledged', 'processing') THEN 'pending' ELSE state END
              WHERE id = ${id}`;
            const { value } = yield* changed(id);
            items.push(value);
            events.push({ _tag: "BackpackItemChanged", item: value });
          }
          return { value: items, events };
        }),
      );

    const scopeOf = (scope: BackpackScope) => {
      switch (scope._tag) {
        case "Hob":
          return sql`AND recipient_id = ${scope.agentId}`;
        case "Quest":
          return sql`AND quest_id = ${scope.questId}`;
        default:
          return sql.literal("");
      }
    };
    // In the order they were recorded within a priority, however often they changed since.
    const byPriority = sql.literal("priority DESC, recorded_sequence");

    return Backpack.of({
      claim,
      renew,
      deliver,
      acknowledge,
      process: (itemId, held) => guarded(itemId, held, "process"),
      requeue: (itemId, held) => guarded(itemId, held, "requeue", { ends: true }),
      resolve: (itemId, held, disposition) =>
        guarded(itemId, held, "resolve", { ends: true, columns: { disposition: dispositionColumn(disposition) } }),
      fail: (itemId, held, error) => guarded(itemId, held, "fail", { ends: true, columns: { error } }),
      expireClaims,
      find: (itemId) =>
        reads.item(itemId).pipe(
          Effect.orDie,
          Effect.flatMap((item) =>
            item === undefined ? Effect.fail(new BackpackItemMissing({ itemId })) : Effect.succeed(item),
          ),
        ),
      listOpen: (scope) =>
        sql<Record<string, unknown>>`SELECT * FROM backpack_items WHERE state NOT IN ('resolved', 'failed')
          ${scopeOf(scope)} ORDER BY ${byPriority}`.pipe(Effect.flatMap(reads.toItems), Effect.orDie),
    });
  }),
);
