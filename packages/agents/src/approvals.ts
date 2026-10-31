import { ApprovalActionChanged, ApprovalClosed, ApprovalNotFound } from "@hobbots/api";
import {
  type AgentId,
  type ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  type ApprovalState,
  type Committed,
  decidedState,
  type MessageId,
  stableJson,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Deferred, Effect, Layer, Option, Semaphore } from "effect";
import { EventPublisher } from "./ports.ts";
import type { ApprovalAction, ApprovalOutcome, PendingApproval, ToolAccess, TurnApprovals } from "./runtime.ts";

/** Where approval requests are stored. Each write journals its event. */
export class ApprovalRepository extends Context.Service<
  ApprovalRepository,
  {
    readonly find: (id: ApprovalId) => Effect.Effect<Option.Option<ApprovalRequest>>;
    /** The thread's requests, oldest first. */
    readonly listForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ApprovalRequest>>;
    readonly listPending: Effect.Effect<ReadonlyArray<ApprovalRequest>>;
    /** Stores a new request with its ApprovalRequested event. */
    readonly insert: (approval: ApprovalRequest) => Effect.Effect<Committed<ApprovalRequest>>;
    /**
     * Saves the request's state, deny reason and decision time from `next` with its ApprovalResolved
     * event. None, and nothing changed, when its stored state is no longer `from`.
     */
    readonly resolve: (
      next: ApprovalRequest,
      from: ApprovalState,
    ) => Effect.Effect<Option.Option<Committed<ApprovalRequest>>>;
  }
>()("@hobbots/agents/ApprovalRepository") {}

/** Identifies one action: the tool, the operation, its targets and the call's concrete arguments. */
export const actionDigest = (action: Pick<ApprovalAction, "tool" | "operation" | "targets" | "arguments">) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        stableJson({
          tool: action.tool,
          operation: action.operation,
          targets: action.targets,
          arguments: action.arguments,
        }),
      ),
    ),
  ).pipe(Effect.map((hash) => Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")));

/** The turn a request pauses: its hob, thread and reply. */
export interface ApprovalOwner {
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** What the user sends to decide a request. `actionDigest` is the one they were shown. */
export interface ApprovalDecisionInput {
  readonly decision: ApprovalDecision;
  readonly actionDigest: string;
  /** Why they deny it, which goes back to the hob. Ignored on approve. */
  readonly reason?: string | undefined;
}

/** A turn's approvals, and the way to close them once the turn has ended. */
export interface TurnApprovalsHandle {
  readonly approvals: TurnApprovals;
  /** Expires the turn's pending requests and refuses new ones: a stopped turn is never approvable late. */
  readonly close: Effect.Effect<void>;
}

interface Waiter {
  readonly owner: TurnApprovalsHandle;
  readonly decision: Deferred.Deferred<ApprovalOutcome>;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * Ask decisions (PE-003, PE-007, PE-008): a tool call the policy answers Ask for becomes a durable
 * request and its turn waits until the user approves it once or denies it. Duplicate decisions are
 * idempotent, a request whose turn ended or whose server restarted expires and cannot be approved
 * late, and a decision applies only to the exact action it names.
 */
export class ApprovalService extends Context.Service<
  ApprovalService,
  {
    /** Approvals for one turn, given how to read the hob's tool access when an approved call runs. */
    readonly forTurn: (
      owner: ApprovalOwner,
      currentAccess: Effect.Effect<ToolAccess | null>,
    ) => Effect.Effect<TurnApprovalsHandle>;
    /**
     * Approves once or denies a pending request, and lets its turn go on. Deciding it again the same
     * way returns it unchanged, so a retried or doubled decision applies once.
     */
    readonly decide: (
      id: ApprovalId,
      input: ApprovalDecisionInput,
    ) => Effect.Effect<ApprovalRequest, ApprovalNotFound | ApprovalClosed | ApprovalActionChanged>;
    readonly listForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ApprovalRequest>>;
  }
>()("@hobbots/agents/ApprovalService") {
  static readonly layer = Layer.effect(
    ApprovalService,
    Effect.gen(function* () {
      const repo = yield* ApprovalRepository;
      const bus = yield* EventPublisher;
      // Decisions, expiries and new requests take turns, so each sees the others' outcome.
      const lock = yield* Semaphore.make(1);
      // The turns waiting in this process, by request. A pending request with no waiter has no turn.
      const waiters = new Map<ApprovalId, Waiter>();

      const announce = <A>(committed: Committed<A>) => Effect.as(bus.publish(committed.entries), committed.value);

      // Moves a pending request to `next`'s state; none when it had already left pending.
      const settle = (next: ApprovalRequest) =>
        repo.resolve(next, "pending").pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (c) => Effect.map(announce(c), Option.some),
            }),
          ),
        );

      const expired = (approval: ApprovalRequest) =>
        Effect.map(nowIso, (now) => new ApprovalRequest({ ...approval, state: "expired", decidedAt: now }));

      // Expires a pending request and lets its turn go on, refused. Runs under the lock.
      const expire = (id: ApprovalId) =>
        Effect.gen(function* () {
          const waiter = waiters.get(id);
          waiters.delete(id);
          const approval = yield* repo.find(id);
          if (Option.isSome(approval) && approval.value.state === "pending") {
            yield* settle(yield* expired(approval.value));
          }
          if (waiter) yield* Deferred.succeed(waiter.decision, { _tag: "Expired" });
        });

      // A previous process may have died while turns waited; those turns are gone, so their requests expire.
      for (const approval of yield* repo.listPending) yield* settle(yield* expired(approval));

      const forTurn = (owner: ApprovalOwner, currentAccess: Effect.Effect<ToolAccess | null>) =>
        Effect.sync(() => {
          let open = true;
          const handle: TurnApprovalsHandle = {
            approvals: {
              currentAccess,
              request: (action) =>
                Semaphore.withPermit(
                  lock,
                  Effect.gen(function* () {
                    const now = yield* nowIso;
                    const approval = new ApprovalRequest({
                      id: ApprovalId.make(crypto.randomUUID()),
                      ...owner,
                      stepId: action.stepId,
                      tool: action.tool,
                      operation: action.operation,
                      targets: action.targets,
                      arguments: action.arguments,
                      label: action.label,
                      reason: action.reason,
                      actionDigest: yield* actionDigest(action),
                      policyVersion: action.policyVersion,
                      state: open ? "pending" : "expired",
                      denyReason: null,
                      createdAt: now,
                      decidedAt: open ? null : now,
                    });
                    const saved = yield* repo.insert(approval).pipe(Effect.flatMap(announce));
                    if (!open) {
                      return { approvalId: saved.id, decision: Effect.succeed({ _tag: "Expired" }) } as PendingApproval;
                    }
                    const decision = yield* Deferred.make<ApprovalOutcome>();
                    waiters.set(saved.id, { owner: handle, decision });
                    return {
                      approvalId: saved.id,
                      // A wait given up (the call was aborted) expires the request.
                      decision: Deferred.await(decision).pipe(
                        Effect.onInterrupt(() => Semaphore.withPermit(lock, expire(saved.id))),
                      ),
                    } satisfies PendingApproval;
                  }),
                ),
            },
            close: Semaphore.withPermit(
              lock,
              Effect.suspend(() => {
                open = false;
                const own = Array.from(waiters).flatMap(([id, waiter]) => (waiter.owner === handle ? [id] : []));
                return Effect.forEach(own, expire, { discard: true });
              }),
            ),
          };
          return handle;
        });

      const decide = Effect.fn("ApprovalService.decide")(function* (id: ApprovalId, input: ApprovalDecisionInput) {
        return yield* Semaphore.withPermit(
          lock,
          Effect.gen(function* () {
            const found = yield* repo.find(id);
            if (Option.isNone(found)) return yield* new ApprovalNotFound({ approvalId: id });
            const approval = found.value;
            const state = decidedState(input.decision);
            if (approval.state === state) return approval;
            if (approval.state !== "pending")
              return yield* new ApprovalClosed({ approvalId: id, state: approval.state });
            if (input.actionDigest !== approval.actionDigest)
              return yield* new ApprovalActionChanged({ approvalId: id });
            const waiter = waiters.get(id);
            // Nothing waits for it here, so no call would run: it can only expire.
            if (waiter === undefined) {
              yield* settle(yield* expired(approval));
              return yield* new ApprovalClosed({ approvalId: id, state: "expired" });
            }
            const denyReason = input.decision === "deny" ? input.reason?.trim() || null : null;
            const next = new ApprovalRequest({ ...approval, state, denyReason, decidedAt: yield* nowIso });
            const saved = yield* settle(next);
            if (Option.isNone(saved)) return yield* new ApprovalClosed({ approvalId: id, state: "expired" });
            waiters.delete(id);
            yield* Deferred.succeed(
              waiter.decision,
              input.decision === "approve"
                ? { _tag: "Approved", actionDigest: approval.actionDigest, policyVersion: approval.policyVersion }
                : { _tag: "Denied", reason: denyReason },
            );
            return saved.value;
          }),
        );
      });

      return ApprovalService.of({ forTurn, decide, listForThread: repo.listForThread });
    }),
  );
}
