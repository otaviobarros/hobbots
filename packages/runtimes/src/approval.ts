import {
  actionDigest,
  type PromptRequest,
  type Redactor,
  type RuntimeEvent,
  type ToolStartedEvent,
  type TurnApprovals,
} from "@hobbots/agents";
import type { ApprovalLifetime } from "@hobbots/domain";
import type { PolicyContext, PolicyEngine, PolicyRequest, PolicyVerdict } from "@hobbots/permissions";
import { Effect } from "effect";
import { narrowestVerdict, toolLabel, toolRequests } from "./tool-calls.ts";

/** Why a call the policy answered Ask for did not run, when no one can be asked. */
export const UNASKABLE = "Hobbots cannot ask you for approval on this turn, so the call did not run.";

export const UNKNOWN_TOOL = (tool: string) => `Hobbots does not know the ${tool} tool, so it stays closed.`;

/** Why a call did not run, in words for the model and the person, when no one was asked. */
export const refusal = (verdict: PolicyVerdict): string =>
  verdict.decision === "ask" ? `${verdict.reason.message} ${UNASKABLE}` : verdict.reason.message;

const denied = (reason: string | null) =>
  reason === null
    ? "The user denied this call, so it did not run."
    : `The user denied this call, so it did not run. Their reason: ${reason}`;

const EXPIRED = "The approval request expired before the user decided, so the call did not run.";
const NO_TOOLS = "The hob no longer has tools, so the approved call did not run.";

/**
 * Reports a call the policy allowed, just before it runs. With `record`, waits until the call is
 * recorded durably and answers whether it may run: a call Hobbots could not record never runs
 * (EX-004). Without it, the call is reported and runs.
 */
export const startCall = (
  record: PromptRequest["recordToolStart"],
  report: (event: RuntimeEvent) => void,
  event: ToolStartedEvent,
): Effect.Effect<boolean> =>
  record
    ? record(event).pipe(Effect.catchDefect(() => Effect.succeed(false)))
    : Effect.sync(() => {
        report(event);
        return true;
      });

/** A tool call as the runtime makes it. */
export interface ToolCall {
  /** The runtime's id for the call. */
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** The folder the runtime reports for the call; relative paths resolve against it. */
  readonly cwd: string;
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

/** Whether a call runs, and the verdict it runs under or why it does not. */
export type CallDecision =
  | {
      readonly _tag: "Run";
      readonly verdict: PolicyVerdict;
      /** The user's approval it runs on, when the policy alone did not allow it. */
      readonly approval?: UserApproval;
    }
  | {
      readonly _tag: "Refuse";
      readonly verdict: PolicyVerdict | undefined;
      readonly reason: string;
      /** The user, when they denied it; otherwise the policy. */
      readonly decidedBy?: "user";
    };

/** Decides a call under the context with the hob's live grants as they are now (PE-008). */
const decideIn = (
  engine: PolicyEngine["Service"],
  base: PolicyContext,
  approvals: TurnApprovals | null | undefined,
  call: ToolCall,
) =>
  Effect.gen(function* () {
    const context: PolicyContext = approvals ? { ...base, grants: yield* approvals.grants } : base;
    // Without the sandbox Bash is never offered. A command that reaches the hook anyway is decided
    // as a command, so it is refused with the reason (PE-005); a `git push` alone is never let through.
    const requests: ReadonlyArray<PolicyRequest> | null =
      call.tool === "Bash" && context.sandbox === "unavailable"
        ? [{ _tag: "Command", operation: "run-commands", cwd: call.cwd }]
        : toolRequests(call.tool, call.input, call.cwd);
    if (requests === null) return undefined;
    return narrowestVerdict(yield* Effect.forEach(requests, (request) => engine.decide(context, request)));
  });

/**
 * A call the policy allows: the grants that answered it are marked used, and it runs on the user's
 * approval when they approved it on this turn or a grant they saved answered it.
 */
const allowed = (
  approvals: TurnApprovals | null | undefined,
  verdict: PolicyVerdict,
  approved: ApprovalLifetime | null,
): Effect.Effect<CallDecision> =>
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
 * Decides a tool call: the policy's answer, and for Ask the user's (PE-003). While the user decides,
 * `report` gets ToolAwaitingApproval. An approved call is decided again under the hob's policy as
 * it is now, just before it runs: it runs when that policy allows it, or still asks for the same
 * action under the same policy version; a changed action or policy asks again (PE-008).
 */
export const decideCall = (
  engine: PolicyEngine["Service"],
  context: PolicyContext,
  approvals: TurnApprovals | null | undefined,
  call: ToolCall,
  report: (event: RuntimeEvent) => void,
  redaction?: Redactor | null,
): Effect.Effect<CallDecision> =>
  Effect.gen(function* () {
    let verdict = yield* decideIn(engine, context, approvals, call);
    if (verdict === undefined) return { _tag: "Refuse", verdict, reason: UNKNOWN_TOOL(call.tool) } as const;
    const label = toolLabel(call.tool, call.input, redaction?.text);
    // The lifetime of the user's last approval of this call, once they approved it.
    let approved: ApprovalLifetime | null = null;
    while (verdict.decision === "ask") {
      if (!approvals) return { _tag: "Refuse", verdict, reason: refusal(verdict) } as const;
      const asked: PolicyVerdict = verdict;
      const pending = yield* approvals.request({
        stepId: call.id,
        tool: call.tool,
        operation: asked.operation,
        targets: asked.targets,
        arguments: call.input,
        label,
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
        label,
      });
      const outcome = yield* pending.decision;
      if (outcome._tag === "Denied")
        return { _tag: "Refuse", verdict: asked, reason: denied(outcome.reason), decidedBy: "user" } as const;
      if (outcome._tag === "Expired") return { _tag: "Refuse", verdict: asked, reason: EXPIRED } as const;
      approved = outcome.lifetime;
      const access = yield* approvals.currentAccess;
      if (access === null) return { _tag: "Refuse", verdict: asked, reason: NO_TOOLS } as const;
      // Approving with a lifetime saved its grants first, so they answer here.
      const now = yield* decideIn(engine, { ...context, ...access.policy }, approvals, call);
      if (now === undefined) return { _tag: "Refuse", verdict: asked, reason: UNKNOWN_TOOL(call.tool) } as const;
      if (now.decision === "ask") {
        const digest = yield* actionDigest({
          ...call,
          operation: now.operation,
          targets: now.targets,
          arguments: call.input,
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
