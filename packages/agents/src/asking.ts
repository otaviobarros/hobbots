import type { ApprovalLifetime, GrantId, GrantRule, PolicyDecision, PolicyOperation } from "@hobbots/domain";
import { Effect } from "effect";
import { actionDigest } from "./approvals.ts";
import type { RuntimeEvent, ToolAccess, TurnApprovals } from "./runtime.ts";

/**
 * Asking the user before a call runs (PE-003, PE-008), for every kind of call: a runtime's own
 * tool calls and the hub's tools, such as a Charm's (ADR 020). The policy engine lives in an
 * adapter, so the loop takes its verdicts in the shape it needs and nothing more.
 */

/** What the loop reads from a policy verdict. The policy engine's own verdict has this shape. */
export interface AskableVerdict {
  readonly decision: PolicyDecision;
  readonly operation: PolicyOperation;
  readonly reason: { readonly message: string };
  readonly targets: ReadonlyArray<string>;
  readonly onceOnly: boolean;
  readonly grantable: boolean;
  readonly rules: ReadonlyArray<GrantRule>;
  readonly grantIds: ReadonlyArray<GrantId>;
  readonly policyVersion: string;
}

/**
 * How the user let a call run: Asked when they approved this call's own request, with the lifetime
 * they picked; Granted when an approval they saved earlier answered it without asking.
 */
export type UserApproval =
  | { readonly _tag: "Asked"; readonly lifetime: ApprovalLifetime }
  | { readonly _tag: "Granted" };

const ASKED = "Hobbots showed the user an approval request for this call before it ran.";
const LIFETIMES: Record<ApprovalLifetime, string> = {
  once: "They approved it just this once, so a call like it asks again.",
  quest: "They approved calls like it for this Quest.",
  always: "They approved calls like it always, so those run without asking from now on.",
};

/**
 * What the hob is told with the result of a call the user approved (#282). The hob never sees the
 * approval card, so without this it cannot tell an approved call from one that needed no approval.
 */
export const approvalNote = (approval: UserApproval): string =>
  approval._tag === "Asked"
    ? `${ASKED} ${LIFETIMES[approval.lifetime]}`
    : "This call ran without a new approval request because an approval the user saved earlier covers it.";

/** Why a call the policy answered Ask for did not run, when no one can be asked. */
export const UNASKABLE = "Hobbots cannot ask you for approval on this turn, so the call did not run.";

/** Why a call did not run, in words for the model and the person, when no one was asked. */
export const refusal = (verdict: AskableVerdict): string =>
  verdict.decision === "ask" ? `${verdict.reason.message} ${UNASKABLE}` : verdict.reason.message;

const denied = (reason: string | null) =>
  reason === null
    ? "The user denied this call, so it did not run."
    : `The user denied this call, so it did not run. Their reason: ${reason}`;

const EXPIRED = "The approval request expired before the user decided, so the call did not run.";
const NO_TOOLS = "The hob no longer has tools, so the approved call did not run.";

/** Whether a call runs, and the verdict it runs under or why it does not. */
export type AskedDecision<V extends AskableVerdict> =
  | {
      readonly _tag: "Run";
      readonly verdict: V;
      /** The user's approval it runs on, when the policy alone did not allow it. */
      readonly approval?: UserApproval;
    }
  | {
      readonly _tag: "Refuse";
      readonly verdict: V | undefined;
      readonly reason: string;
      /** The user, when they denied it; otherwise the policy. */
      readonly decidedBy?: "user";
    };

/** The call the loop asks about, as the approval card shows it and its digest names it. */
export interface AskedCall {
  /** The step the call shows as in the reply, which is the runtime's own id for the call. */
  readonly id: string;
  readonly tool: string;
  /** The call's exact arguments: what the approval card shows and its digest covers. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly label: string;
}

export interface AskOptions<V extends AskableVerdict> {
  readonly call: AskedCall;
  /** Asks the user; absent or null, a call the policy answers Ask for is refused. */
  readonly approvals: TurnApprovals | null | undefined;
  /**
   * Decides the call with the hob's live grants. `access` is the hob's tool access as it is now, after
   * an approval; null for the first decision, under the turn's own. Undefined when the call is unknown.
   */
  readonly decide: (access: ToolAccess | null) => Effect.Effect<V | undefined>;
  /** Gets ToolAwaitingApproval while the user decides. */
  readonly report: (event: RuntimeEvent) => void;
  /** Why an unknown call is refused. */
  readonly unknown: string;
}

/**
 * A call the policy allows: the grants that answered it are marked used, and it runs on the user's
 * approval when they approved it on this turn or a grant they saved answered it.
 */
const allowed = <V extends AskableVerdict>(
  approvals: TurnApprovals | null | undefined,
  verdict: V,
  approved: ApprovalLifetime | null,
): Effect.Effect<AskedDecision<V>> =>
  Effect.gen(function* () {
    const granted = verdict.grantIds.length > 0;
    if (approvals && granted) yield* approvals.used(verdict.grantIds);
    // An approval with a lifetime saved its grants first, so they answer the call it approved.
    if (approved !== null) return { _tag: "Run", verdict, approval: { _tag: "Asked", lifetime: approved } } as const;
    return granted && approvals
      ? ({ _tag: "Run", verdict, approval: { _tag: "Granted" } } as const)
      : ({ _tag: "Run", verdict } as const);
  });

/**
 * Decides a call: the policy's answer, and for Ask the user's (PE-003). While the user decides,
 * `report` gets ToolAwaitingApproval. An approved call is decided again under the hob's policy as
 * it is now, just before it runs: it runs when that policy allows it, or still asks for the same
 * action under the same policy version; a changed action or policy asks again (PE-008).
 */
export const askUntilDecided = <V extends AskableVerdict>(options: AskOptions<V>): Effect.Effect<AskedDecision<V>> =>
  Effect.gen(function* () {
    const { call, approvals, decide, report } = options;
    let verdict = yield* decide(null);
    if (verdict === undefined) return { _tag: "Refuse", verdict, reason: options.unknown } as const;
    // The lifetime of the user's last approval of this call, once they approved it.
    let approved: ApprovalLifetime | null = null;
    while (verdict.decision === "ask") {
      if (!approvals) return { _tag: "Refuse", verdict, reason: refusal(verdict) } as const;
      const asked: V = verdict;
      const pending = yield* approvals.request({
        stepId: call.id,
        tool: call.tool,
        operation: asked.operation,
        targets: asked.targets,
        arguments: call.arguments,
        label: call.label,
        reason: asked.reason.message,
        policyVersion: asked.policyVersion,
        onceOnly: asked.onceOnly,
        grantable: asked.grantable,
        rules: asked.rules,
      });
      report({
        _tag: "ToolAwaitingApproval",
        id: call.id,
        approvalId: pending.approvalId,
        tool: call.tool,
        operation: asked.operation,
        targets: asked.targets,
        label: call.label,
      });
      const outcome = yield* pending.decision;
      if (outcome._tag === "Denied")
        return { _tag: "Refuse", verdict: asked, reason: denied(outcome.reason), decidedBy: "user" } as const;
      if (outcome._tag === "Expired") return { _tag: "Refuse", verdict: asked, reason: EXPIRED } as const;
      approved = outcome.lifetime;
      const access = yield* approvals.currentAccess;
      if (access === null) return { _tag: "Refuse", verdict: asked, reason: NO_TOOLS } as const;
      // Approving with a lifetime saved its grants first, so they answer here.
      const now = yield* decide(access);
      if (now === undefined) return { _tag: "Refuse", verdict: asked, reason: options.unknown } as const;
      if (now.decision === "ask") {
        const digest = yield* actionDigest({
          tool: call.tool,
          operation: now.operation,
          targets: now.targets,
          arguments: call.arguments,
        });
        if (digest === outcome.actionDigest && now.policyVersion === outcome.policyVersion) {
          return { _tag: "Run", verdict: now, approval: { _tag: "Asked", lifetime: approved } } as const;
        }
      }
      verdict = now;
    }
    if (verdict.decision !== "allow") return { _tag: "Refuse", verdict, reason: refusal(verdict) } as const;
    return yield* allowed(approvals, verdict, approved);
  });
