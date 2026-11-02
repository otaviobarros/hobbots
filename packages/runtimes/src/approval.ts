import {
  type AskedDecision,
  askUntilDecided,
  type PromptRequest,
  type Redactor,
  type RuntimeEvent,
  type ToolStartedEvent,
  type TurnApprovals,
} from "@hobbots/agents";
import type { PolicyContext, PolicyEngine, PolicyRequest, PolicyVerdict } from "@hobbots/permissions";
import { Effect } from "effect";
import { narrowestVerdict, toolLabel, toolRequests } from "./tool-calls.ts";

export const UNKNOWN_TOOL = (tool: string) => `Hobbots does not know the ${tool} tool, so it stays closed.`;

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

/** The folders a call pushes from with Git, as the hub reads its command. */
const pushesFrom = (call: ToolCall) => [
  ...new Set(
    (toolRequests(call.tool, call.input, call.cwd) ?? []).flatMap((request) =>
      request._tag === "Push" && request.cwd !== undefined ? [request.cwd] : [],
    ),
  ),
];

/** The hub tool a call's `git push` is pointed to instead, or null when none is. */
const steeredTo = (call: ToolCall, steersPush: ((cwd: string) => Effect.Effect<string | null>) | undefined) =>
  Effect.gen(function* () {
    if (steersPush === undefined) return null;
    for (const cwd of pushesFrom(call)) {
      const tool = yield* steersPush(cwd);
      if (tool !== null) return tool;
    }
    return null;
  });

/**
 * Why a `git push` command is refused when the turn offers the GitHub Charm's push for its folder (ADR 020): in any
 * preset, since the Charm pushes with the user's sign-in under the hob's policy, and Git in the
 * sandbox cannot.
 */
export const steerPush = (tool: string) =>
  `Push with the ${tool} tool instead of git push: Hobbots pushes your branch to GitHub for you, as the user and under your policy. A git push from your sandbox cannot sign in.`;

/** Whether a call runs, and the verdict it runs under or why it does not. */
export type CallDecision = AskedDecision<PolicyVerdict>;

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
 * Decides a tool call: the policy's answer, and for Ask the user's (PE-003). While the user decides,
 * `report` gets ToolAwaitingApproval. An approved call is decided again under the hob's policy as
 * it is now, just before it runs (PE-008).
 */
export const decideCall = (
  engine: PolicyEngine["Service"],
  context: PolicyContext,
  approvals: TurnApprovals | null | undefined,
  call: ToolCall,
  report: (event: RuntimeEvent) => void,
  redaction?: Redactor | null,
  steersPush?: (cwd: string) => Effect.Effect<string | null>,
): Effect.Effect<CallDecision> =>
  Effect.flatMap(steeredTo(call, steersPush), (pushTool) =>
    pushTool !== null
      ? Effect.succeed<CallDecision>({ _tag: "Refuse", verdict: undefined, reason: steerPush(pushTool) })
      : askUntilDecided({
          call: {
            id: call.id,
            tool: call.tool,
            arguments: call.input,
            label: toolLabel(call.tool, call.input, redaction?.text),
          },
          approvals,
          decide: (access) =>
            decideIn(engine, access === null ? context : { ...context, ...access.policy }, approvals, call),
          report,
          unknown: UNKNOWN_TOOL(call.tool),
        }),
  );
