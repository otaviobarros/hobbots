import { Schema } from "effect";
import { ApprovalRequest } from "./approval.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { ArtifactRef, Checkpoint, Delegation, HandOff, QuestId, Question } from "./quest.ts";
import { Revision } from "./revision.ts";
import { AttemptId, Task, TaskId } from "./task.ts";

/**
 * A hob's backpack (ADR 019): the durable queue of what that hob still has to deal with. Your
 * Inbox is what needs you; a backpack item is what needs one hob. The backpack row is also the
 * outbox: it is committed with the change that caused it, before anything delivers it.
 */

export const BackpackItemId = Schema.String.pipe(Schema.brand("BackpackItemId"));
export type BackpackItemId = typeof BackpackItemId.Type;

/** The kinds of ADR 019. Every kind but `progress` is actionable and can wake its hob (IN-005). */
export const BackpackItemKind = Schema.Literals([
  "task",
  "result",
  "failure",
  "checkpoint",
  "question",
  "answer",
  "hand-off",
  "message",
  "approval-outcome",
  "deadline",
  "progress",
]);
export type BackpackItemKind = typeof BackpackItemKind.Type;

export const isActionableKind = (kind: BackpackItemKind): boolean => kind !== "progress";

/**
 * How soon an item should be dealt with among a hob's open items, higher first: an answer or an
 * approval outcome unblocks work that waits for it, routine progress waits for the next turn.
 */
export const backpackPriority = (kind: BackpackItemKind): number =>
  kind === "answer" || kind === "approval-outcome" ? 2 : isActionableKind(kind) ? 1 : 0;

/** What the item carries, by kind: the records its hob reads to act on it. */
export const BackpackPayload = Schema.Union([
  /** A delegated Task or a planned step, with the brief that came with a delegation. */
  Schema.TaggedStruct("task", { task: Task, delegation: Schema.NullOr(Delegation) }),
  /** A Task under the recipient's passed the completion gate, with what it made. */
  Schema.TaggedStruct("result", { task: Task, artifacts: Schema.Array(ArtifactRef) }),
  /** A Task under the recipient's failed, was blocked or was cancelled. */
  Schema.TaggedStruct("failure", { task: Task }),
  /** A milestone, finding, blocker or question a member reported. */
  Schema.TaggedStruct("checkpoint", { checkpoint: Checkpoint }),
  Schema.TaggedStruct("question", { question: Question }),
  Schema.TaggedStruct("answer", { question: Question }),
  Schema.TaggedStruct("hand-off", { handOff: HandOff, artifact: ArtifactRef }),
  /** A note from you (`senderId` null) or between a lead and its member. */
  Schema.TaggedStruct("message", { senderId: Schema.NullOr(AgentId), text: Schema.String }),
  Schema.TaggedStruct("approval-outcome", { approval: ApprovalRequest }),
  Schema.TaggedStruct("deadline", { taskId: TaskId, dueAt: Schema.String }),
  /** Routine progress, including the hub's started and waiting states. */
  Schema.TaggedStruct("progress", { checkpoint: Checkpoint }),
]);
export type BackpackPayload = typeof BackpackPayload.Type;

/**
 * - `pending`: committed, waiting for a turn.
 * - `delivered`: put into a turn's prompt or a live turn's waiting tool call.
 * - `acknowledged`: the runtime accepted that turn, by its own evidence.
 * - `processing`: the turn runs and holds the item's claim.
 * - `resolved`: handled; its disposition says how.
 * - `failed`: delivery or processing ran out of retries, or the recipient can no longer take it.
 */
export const BackpackItemState = Schema.Literals([
  "pending",
  "delivered",
  "acknowledged",
  "processing",
  "resolved",
  "failed",
]);
export type BackpackItemState = typeof BackpackItemState.Type;

export const isSettledItem = (state: BackpackItemState): boolean => state === "resolved" || state === "failed";

/** How a resolved item was handled (ADR 019). */
export const BackpackDisposition = Schema.Union([
  /** A turn that ended, or the `complete_task` call that settled it, took it in. */
  Schema.TaggedStruct("consumed", { by: Schema.String }),
  /** A tool call answered it. */
  Schema.TaggedStruct("answered", { toolCall: Schema.String }),
  /** Its Task had ended or moved on: checked against this Task version, it started nothing. */
  Schema.TaggedStruct("late", { taskRevision: Schema.Int }),
  /** Someone dismissed it: you (`by` null) or a hob. */
  Schema.TaggedStruct("dismissed", { by: Schema.NullOr(AgentId) }),
]);
export type BackpackDisposition = typeof BackpackDisposition.Type;

/**
 * A worker's hold on an item while it delivers it (ADR 019). `token` grows on every claim, and
 * again when a claim ends without its owner, so a worker whose lease ran out is refused.
 */
export const BackpackClaim = Schema.Struct({
  owner: Schema.String,
  token: Schema.Int,
  /** When the lease runs out, by the database's clock (ISO 8601). */
  leaseExpiresAt: Schema.String,
});
export type BackpackClaim = typeof BackpackClaim.Type;

/** One time an item was put into a turn, and the runtime's evidence that it accepted that turn. */
export class BackpackDelivery extends Schema.Class<BackpackDelivery>("BackpackDelivery")({
  /** 1 for the first delivery, one more for each retry. */
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The thread or Attempt session the turn runs in. */
  target: Schema.String,
  /** The turn: its reply message or Attempt id. */
  turnId: Schema.String,
  deliveredAt: Schema.String,
  /** The runtime session the adapter reported when the turn started, once it did. */
  acknowledgedSessionId: Schema.NullOr(Schema.String),
  acknowledgedAt: Schema.NullOr(Schema.String),
}) {}

export class BackpackItem extends Schema.Class<BackpackItem>("BackpackItem")({
  id: BackpackItemId,
  /** The hob whose backpack it is in. */
  recipientId: AgentId,
  kind: BackpackItemKind,
  actionable: Schema.Boolean,
  /** Higher first among a hob's open items; see `backpackPriority`. */
  priority: Schema.Int,
  state: BackpackItemState,
  /** The Task it is about, the nearest Quest above that Task, and the Attempt it came from. */
  taskId: Schema.NullOr(TaskId),
  questId: Schema.NullOr(QuestId),
  attemptId: Schema.NullOr(AttemptId),
  /** The thread its Task's tree belongs to. */
  threadId: Schema.NullOr(ThreadId),
  /** Unique per recipient: a second item with the same key is never recorded (ADR 019). */
  dedupeKey: Schema.String,
  payload: BackpackPayload,
  /** For a deadline, the time before which it is not delivered. */
  notBefore: Schema.NullOr(Schema.String),
  claim: Schema.NullOr(BackpackClaim),
  /** The latest claim's fencing token, kept after the claim ends; 0 before the first. */
  fencingToken: Schema.Int,
  deliveries: Schema.Array(BackpackDelivery),
  disposition: Schema.NullOr(BackpackDisposition),
  /** Why it failed, once it has. */
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Revision,
}) {}

/** A backpack item as the change that causes it describes it, before it is stored. */
export interface NewBackpackItem {
  readonly recipientId: AgentId;
  readonly taskId: TaskId | null;
  readonly questId: QuestId | null;
  readonly attemptId: AttemptId | null;
  readonly threadId: ThreadId | null;
  readonly dedupeKey: string;
  readonly payload: BackpackPayload;
  readonly notBefore: string | null;
}

/** The steps an item takes after it is recorded; each needs the item's live claim. */
export const BackpackStep = Schema.Literals(["deliver", "acknowledge", "process", "requeue", "resolve", "fail"]);
export type BackpackStep = typeof BackpackStep.Type;

const STEPS: Record<BackpackStep, { readonly from: ReadonlyArray<BackpackItemState>; readonly to: BackpackItemState }> =
  {
    deliver: { from: ["pending"], to: "delivered" },
    acknowledge: { from: ["delivered"], to: "acknowledged" },
    process: { from: ["acknowledged"], to: "processing" },
    // A turn that ended early, by interruption, a crash or a runtime failure: never resolved.
    requeue: { from: ["delivered", "acknowledged", "processing"], to: "pending" },
    // A late or dismissed item resolves without a turn, so a pending one can resolve too.
    resolve: { from: ["pending", "delivered", "acknowledged", "processing"], to: "resolved" },
    fail: { from: ["pending", "delivered", "acknowledged", "processing"], to: "failed" },
  };

/** The states a step can start from, and the state it leads to. */
export const backpackStep = (step: BackpackStep) => STEPS[step];

/** A step the item's current state does not allow (IN-002). */
export class IllegalBackpackTransition extends Schema.TaggedError<IllegalBackpackTransition>()(
  "IllegalBackpackTransition",
  { itemId: BackpackItemId, from: BackpackItemState, step: BackpackStep },
) {}

/**
 * A write under a claim that no longer holds: another owner, an older fencing token, or a lease
 * that ran out by the database's clock. Nothing was written, and the worker drops its outcome.
 */
export class StaleBackpackClaim extends Schema.TaggedError<StaleBackpackClaim>()("StaleBackpackClaim", {
  itemId: BackpackItemId,
  token: Schema.Int,
}) {}

/** No backpack item has this id. */
export class BackpackItemMissing extends Schema.TaggedError<BackpackItemMissing>()("BackpackItemMissing", {
  itemId: BackpackItemId,
}) {}

/** The item is not waiting for a turn, or a live claim holds it already. */
export class BackpackItemUnclaimable extends Schema.TaggedError<BackpackItemUnclaimable>()("BackpackItemUnclaimable", {
  itemId: BackpackItemId,
  reason: Schema.Literals(["not-pending", "claimed"]),
}) {}
