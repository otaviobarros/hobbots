import {
  ApprovalRequest,
  type BackpackItem,
  type BackpackItemId,
  type CarriedItem,
  type JournaledEvent,
  type ResponsibilityLedger,
  responsibilityLedger,
  supersededItems,
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

/** Whether the completing turn carries `item`: under a claim that still holds, or still pending and unclaimed at the token it saw. */
const carries = (item: BackpackItem, claimLive: boolean, carried: CarriedItem | undefined) => {
  if (carried === undefined || item.fencingToken !== carried.token) return false;
  if (carried.owner === null) return item.state === "pending" && item.claim === null;
  return item.claim?.owner === carried.owner && claimLive;
};

/** A Task's ledger as one transaction reads it, and the carried items its completion consumes. */
export interface LedgerRead {
  readonly ledger: ResponsibilityLedger;
  readonly consumes: ReadonlyArray<{ readonly item: BackpackItem; readonly carried: CarriedItem }>;
  /** Items about ended Tasks under it that the ledger no longer counts; the completion resolves them as late. */
  readonly superseded: ReturnType<typeof supersededItems>;
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
   * Approval requests still pending on the Task's work and not past their expiry. A chat turn works
   * on the request's top Task in its thread; a party member's turn names its own Task; a step's
   * session never asks.
   */
  const pendingApprovals = (task: Task, now: string) =>
    task.threadId === null
      ? Effect.succeed([])
      : (task.parentId === null
          ? sql<Row>`SELECT * FROM approval_requests WHERE state = 'pending' AND thread_id = ${task.threadId}
              AND agent_id = ${task.ownerId} AND task_id IS NULL AND (expires_at IS NULL OR expires_at > ${now})
              ORDER BY created_at, id`
          : sql<Row>`SELECT * FROM approval_requests WHERE state = 'pending' AND task_id = ${task.id}
              AND (expires_at IS NULL OR expires_at > ${now})
              ORDER BY created_at, id`
        ).pipe(Effect.map(approvalRows), Effect.flatMap(decodeApprovals), Effect.orDie);

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
        // The Task's own result or failure is for the Task above it, even when one hob owns both,
        // as a step's: an earlier failure of a Task retried since never keeps it open.
        if (item.taskId === task.id && (item.kind === "result" || item.kind === "failure")) continue;
        const holds = byId.get(item.id);
        if (holds !== undefined && carries(item, live, holds)) consumes.push({ item, carried: holds });
        else blocking.push(item);
      }
      const approvals = yield* pendingApprovals(task, DateTime.formatIso(yield* DateTime.now));
      const ledger = responsibilityLedger(task, { subtree, tree, approvals, items: blocking });
      return { ledger, consumes, superseded: supersededItems(task, subtree, blocking) } satisfies LedgerRead;
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
          carried.owner === null
            ? sql`state = 'pending' AND claim_owner IS NULL`
            : sql`claim_owner = ${carried.owner} AND ${clock.leaseLive} AND state NOT IN ('resolved', 'failed')`;
        const updated = yield* sql`UPDATE backpack_items SET state = 'resolved', disposition = ${disposition},
            claim_owner = NULL, lease_expires_at = NULL, updated_at = ${at}, revision = ${first + index}
          WHERE id = ${item.id} AND claim_token = ${carried.token} AND ${guard} RETURNING id`;
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

  /**
   * Resolves the items the ledger no longer counts as late, against the version their ended Task
   * ended at, in the completion's transaction from sequence `first` on. Only an item still pending
   * and unclaimed at the token read: one a worker holds is left for it to find late.
   */
  const retire = (superseded: LedgerRead["superseded"], first: number) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      const events: Array<JournaledEvent> = [];
      for (const { item, taskRevision } of superseded) {
        const updated = yield* sql`UPDATE backpack_items
          SET state = 'resolved', disposition = ${dispositionColumn({ _tag: "late", taskRevision })},
            updated_at = ${at}, revision = ${first + events.length}
          WHERE id = ${item.id} AND state = 'pending' AND claim_owner IS NULL AND claim_token = ${item.fencingToken}
          RETURNING id`;
        if (updated.length === 0) continue;
        const resolved = yield* items.item(item.id as BackpackItemId);
        if (resolved !== undefined) events.push({ _tag: "BackpackItemChanged", item: resolved });
      }
      return events;
    });

  /**
   * What a retry or a reassignment of `task` makes late, still waiting unclaimed: the Failures about
   * it for whoever is above it, since the Task is open again, and after a reassignment whatever its
   * earlier owner held about it, since that hob no longer owns it. Late at the version it was.
   */
  const staleItems = (task: Task, from: string | null) =>
    Effect.gen(function* () {
      const rows = yield* sql<Row>`SELECT * FROM backpack_items
        WHERE task_id = ${task.id} AND state = 'pending' AND claim_owner IS NULL
          AND (kind = 'failure' OR recipient_id = ${from ?? ""})
        ORDER BY recorded_sequence`;
      return (yield* items.toItems(rows)).map((item) => ({ item, taskRevision: task.revision }));
    });

  /** Who consumed the items: the `complete_task` call the change runs in, or else the Attempt that produced the result. */
  const consumer = (attemptId: string) =>
    Effect.map(CurrentToolCall, (call) =>
      call === null ? `attempt:${attemptId}` : `tool:${call.agentId}:${call.key}`,
    );

  return { readFor, consume, retire, staleItems, consumer };
};
