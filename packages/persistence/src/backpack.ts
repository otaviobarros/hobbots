import {
  type BackpackItem,
  type BackpackItemId,
  BackpackItemMissing,
  BackpackItemNotBlocked,
  BackpackItemUnclaimable,
  type BackpackStep,
  type BlockerReason,
  backpackStep,
  blockerNextAction,
  IllegalBackpackTransition,
  type JournaledEvent,
  StaleBackpackClaim,
} from "@hobbots/domain";
import { Backpack, type BackpackScope, type HeldClaim } from "@hobbots/inbox";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { dispositionColumn, makeDatabaseClock, makeItemReads } from "./backpack-rows.ts";
import { lockJournal, makeJournaledChange } from "./journal.ts";

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

    /** Records a blocker for the item that just failed, inside the failing write's transaction. */
    const raiseBlocker = (itemId: BackpackItemId, reason: BlockerReason, error: string) =>
      isoNow.pipe(
        Effect.flatMap(
          (at) => sql`INSERT INTO backpack_blockers
              (item_id, number, reason, next_action, error, after_deliveries, raised_at, decision, decided_at)
            SELECT ${itemId}, COALESCE(MAX(number), 0) + 1, ${reason}, ${blockerNextAction(reason)}, ${error},
              (SELECT COUNT(*) FROM backpack_deliveries WHERE item_id = ${itemId}), ${at}, NULL, NULL
            FROM backpack_blockers WHERE item_id = ${itemId}`,
        ),
        Effect.asVoid,
      );

    const abandon: Backpack["Service"]["abandon"] = (itemId, error) =>
      change((revision) =>
        Effect.gen(function* () {
          const { from, to } = backpackStep("abandon");
          const updated = yield* sql`UPDATE backpack_items SET state = ${to}, error = ${error},
              updated_at = ${yield* isoNow}, revision = ${revision}
            WHERE id = ${itemId} AND ${sql.in("state", from)} AND claim_owner IS NULL AND actionable = 1
            RETURNING id`;
          if (updated.length === 0) {
            const [row] = yield* sql`SELECT id FROM backpack_items WHERE id = ${itemId}`;
            if (row === undefined) return yield* new BackpackItemMissing({ itemId });
            return { value: null, events: [] };
          }
          yield* raiseBlocker(itemId, "recipient-retired", error);
          return yield* changed(itemId);
        }),
      );

    const decide: Backpack["Service"]["decide"] = (itemId, action) =>
      change((revision) =>
        Effect.gen(function* () {
          const at = yield* isoNow;
          // Only a failed item's open blocker takes a choice, and only once: the first choice wins.
          const { from, to } = backpackStep(action);
          const decided = yield* sql`UPDATE backpack_blockers SET decision = ${action}, decided_at = ${at}
            WHERE item_id = ${itemId} AND decision IS NULL
              AND number = (SELECT MAX(number) FROM backpack_blockers WHERE item_id = ${itemId})
              AND EXISTS (SELECT 1 FROM backpack_items WHERE id = ${itemId} AND ${sql.in("state", from)})
            RETURNING item_id`;
          if (decided.length === 0) {
            const [row] = yield* sql<{ readonly state: string }>`SELECT state FROM backpack_items WHERE id = ${itemId}`;
            if (row === undefined) return yield* new BackpackItemMissing({ itemId });
            return yield* new BackpackItemNotBlocked({ itemId, state: row.state as BackpackItem["state"] });
          }
          const columns =
            action === "retry"
              ? { state: to, error: null }
              : { state: to, disposition: dispositionColumn({ _tag: "dismissed", by: null }) };
          yield* sql`UPDATE backpack_items SET ${sql.update({ ...columns, updated_at: at, revision })}
            WHERE id = ${itemId}`;
          return yield* changed(itemId);
        }),
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

    const fenced: Backpack["Service"]["fenced"] = (itemId, held, effect, options = {}) =>
      Effect.gen(function* () {
        // The journal's head first, as every journaled change takes it, so this never waits on a
        // renewal or an expiry that holds the head and waits on the item. Then the item's row:
        // holding it keeps an expiry off until the transaction ends, so the claim checked is the
        // claim the effect commits under.
        yield* lockJournal(sql);
        const live = yield* sql`UPDATE backpack_items SET claim_token = claim_token
          WHERE id = ${itemId} AND claim_owner = ${held.owner} AND claim_token = ${held.token}
            AND ${clock.leaseLive} AND state IN ('acknowledged', 'processing')
          RETURNING id`;
        if (live.length === 0) return yield* refuse(itemId, held, "process");
        const value = yield* effect;
        const settled =
          options.consumes === undefined
            ? null
            : yield* guarded(itemId, held, "resolve", {
                ends: true,
                columns: { disposition: dispositionColumn({ _tag: "consumed", by: options.consumes }) },
              });
        return { value, settled };
      }).pipe(
        sql.withTransaction,
        Effect.catchIf(
          (error): error is SqlError.SqlError => SqlError.isSqlError(error),
          (error) => Effect.die(error),
        ),
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
      fail: (itemId, held, error) =>
        guarded(itemId, held, "fail", {
          ends: true,
          columns: { error },
          also: raiseBlocker(itemId, "retries-exhausted", error),
        }),
      abandon,
      decide,
      fenced,
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
      listBlocked: (scope) =>
        sql<Record<string, unknown>>`SELECT * FROM backpack_items WHERE state = 'failed'
          AND EXISTS (SELECT 1 FROM backpack_blockers b WHERE b.item_id = backpack_items.id AND b.decision IS NULL)
          ${scopeOf(scope)}
          ORDER BY (SELECT MAX(raised_at) FROM backpack_blockers b WHERE b.item_id = backpack_items.id), id`.pipe(
          Effect.flatMap(reads.toItems),
          Effect.orDie,
        ),
    });
  }),
);
