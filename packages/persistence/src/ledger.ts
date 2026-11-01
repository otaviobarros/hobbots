import {
  ApprovalRequest,
  type BackpackItem,
  type BackpackItemId,
  type CarriedItem,
  type JournaledEvent,
  type ResponsibilityLedger,
  responsibilityLedger,
  type Task,
  TaskRefused,
} from "@hobbots/domain";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { approvalRows } from "./approvals.ts";
import { CurrentToolCall, dispositionColumn, makeDatabaseClock, makeItemReads } from "./backpack-rows.ts";
import { makeTaskReads } from "./task-rows.ts";

type Row = Record<string, unknown>;

const decodeApprovals = Schema.decodeUnknownEffect(Schema.Array(ApprovalRequest));

/** Whether the completing turn carries `item`, by a claim that still holds or as an item still pending and unclaimed. */
const carries = (item: BackpackItem, claimLive: boolean, carried: CarriedItem | undefined) => {
  if (carried === undefined) return false;
  if (carried.claim === null) return item.state === "pending" && item.claim === null;
  return item.claim?.owner === carried.claim.owner && item.claim.token === carried.claim.token && claimLive;
};

/** A Task's ledger as one transaction reads it, and the carried items its completion consumes. */
export interface LedgerRead {
  readonly ledger: ResponsibilityLedger;
  readonly consumes: ReadonlyArray<{ readonly item: BackpackItem; readonly carried: CarriedItem }>;
}

/**
 * Reads the responsibility ledger (ADR 019) over the Task tree, pending approvals and the
 * backpack, inside the caller's transaction. Leases are judged by the database's clock.
 */
export const makeLedger = (sql: SqlClient.SqlClient) => {
  const read = makeTaskReads(sql);
  const items = makeItemReads(sql);
  const clock = makeDatabaseClock(sql);

  /** The owner's open actionable items about the Task or a Task under it, each with whether its claim's lease runs. */
  const openItems = (task: Task, scope: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql<Row>`SELECT backpack_items.*,
          CASE WHEN claim_owner IS NOT NULL AND ${clock.leaseLive} THEN 1 ELSE 0 END AS claim_live
        FROM backpack_items
        WHERE recipient_id = ${task.ownerId} AND actionable = 1 AND state NOT IN ('resolved', 'failed')
          AND ${sql.in("task_id", scope)}
        ORDER BY priority DESC, recorded_sequence`;
      const live = new Map(rows.map((row) => [String(row.id), Number(row.claimLive) === 1]));
      const found = yield* items.toItems(rows);
      return found.map((item) => ({ item, live: live.get(item.id) ?? false }));
    });

  /**
   * Approval requests still pending on the Task's work. A request belongs to a chat turn, and a
   * chat turn works on the request's top Task in its thread; a step's session never asks.
   */
  const pendingApprovals = (task: Task) =>
    task.threadId === null || task.parentId !== null
      ? Effect.succeed([])
      : sql<Row>`SELECT * FROM approval_requests WHERE state = 'pending' AND thread_id = ${task.threadId}
          AND agent_id = ${task.ownerId} ORDER BY created_at, id`.pipe(
          Effect.map(approvalRows),
          Effect.flatMap(decodeApprovals),
          Effect.orDie,
        );

  /** The ledger of `task`, less the items in `carried` that the completing turn really carries. */
  const readFor = (task: Task, carried: ReadonlyArray<CarriedItem> = []) =>
    Effect.gen(function* () {
      const subtree = yield* read.readTree(task.id);
      if (subtree === null) return yield* Effect.die(new Error(`Task ${task.id} vanished`));
      const tree = yield* read.treeOf(task.rootId);
      const byId = new Map(carried.map((each) => [each.itemId as string, each]));
      const consumes: Array<LedgerRead["consumes"][number]> = [];
      const blocking: Array<BackpackItem> = [];
      for (const { item, live } of yield* openItems(
        task,
        subtree.tasks.map((each) => each.id),
      )) {
        const holds = byId.get(item.id);
        if (holds !== undefined && carries(item, live, holds)) consumes.push({ item, carried: holds });
        else blocking.push(item);
      }
      const approvals = yield* pendingApprovals(task);
      const ledger = responsibilityLedger(task, { subtree, tree, approvals, items: blocking });
      return { ledger, consumes } satisfies LedgerRead;
    });

  /**
   * Resolves the carried items as consumed by the completion, in its transaction, from journal
   * sequence `first` on. Each write is guarded as `carries` judged it, so an item claimed or moved
   * meanwhile refuses the completion and nothing of it is kept.
   */
  const consume = (consumes: LedgerRead["consumes"], by: string, first: number) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      const disposition = dispositionColumn({ _tag: "consumed", by });
      const events: Array<JournaledEvent> = [];
      for (const [index, { item, carried }] of consumes.entries()) {
        const guard =
          carried.claim === null
            ? sql`state = 'pending' AND claim_owner IS NULL`
            : sql`claim_owner = ${carried.claim.owner} AND claim_token = ${carried.claim.token} AND ${clock.leaseLive}
                AND state NOT IN ('resolved', 'failed')`;
        const updated = yield* sql`UPDATE backpack_items SET state = 'resolved', disposition = ${disposition},
            claim_owner = NULL, lease_expires_at = NULL, updated_at = ${at}, revision = ${first + index}
          WHERE id = ${item.id} AND ${guard} RETURNING id`;
        if (updated.length === 0) {
          return yield* new TaskRefused({
            reason: "items-open",
            message: `Backpack item ${item.id} changed while the Task completed; try again.`,
          });
        }
        const resolved = yield* items.item(item.id as BackpackItemId);
        if (resolved !== undefined) events.push({ _tag: "BackpackItemChanged", item: resolved });
      }
      return events;
    });

  /** Who consumed the items: the `complete_task` call the change runs in, or else the Attempt that produced the result. */
  const consumer = (attemptId: string) =>
    Effect.map(CurrentToolCall, (call) =>
      call === null ? `attempt:${attemptId}` : `tool:${call.agentId}:${call.key}`,
    );

  return { readFor, consume, consumer };
};
