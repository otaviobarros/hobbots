import { actionDigest, type RuntimeEvent, type TurnApprovals } from "@hobbots/agents";
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

/** A tool call as the runtime makes it. */
export interface ToolCall {
  /** The runtime's id for the call. */
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** The folder the runtime reports for the call; relative paths resolve against it. */
  readonly cwd: string;
}

/** Whether a call runs, and the verdict it runs under or why it does not. */
export type CallDecision =
  | { readonly _tag: "Run"; readonly verdict: PolicyVerdict }
  | {
      readonly _tag: "Refuse";
      readonly verdict: PolicyVerdict | undefined;
      readonly reason: string;
      /** The user, when they denied it; otherwise the policy. */
      readonly decidedBy?: "user";
    };

const decideIn = (engine: PolicyEngine["Service"], context: PolicyContext, call: ToolCall) =>
  Effect.gen(function* () {
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
): Effect.Effect<CallDecision> =>
  Effect.gen(function* () {
    let verdict = yield* decideIn(engine, context, call);
    if (verdict === undefined) return { _tag: "Refuse", verdict, reason: UNKNOWN_TOOL(call.tool) } as const;
    const label = toolLabel(call.tool, call.input);
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
      const access = yield* approvals.currentAccess;
      if (access === null) return { _tag: "Refuse", verdict: asked, reason: NO_TOOLS } as const;
      const now = yield* decideIn(engine, { ...context, ...access.policy }, call);
      if (now === undefined) return { _tag: "Refuse", verdict: asked, reason: UNKNOWN_TOOL(call.tool) } as const;
      if (now.decision === "ask") {
        const digest = yield* actionDigest({
          ...call,
          operation: now.operation,
          targets: now.targets,
          arguments: call.input,
        });
        if (digest === outcome.actionDigest && now.policyVersion === outcome.policyVersion) {
          return { _tag: "Run", verdict: now } as const;
        }
      }
      verdict = now;
    }
    return verdict.decision === "allow"
      ? ({ _tag: "Run", verdict } as const)
      : ({ _tag: "Refuse", verdict, reason: refusal(verdict) } as const);
  });
