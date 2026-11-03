import { basename } from "node:path";
import { type PromptRequest, type RuntimeEvent, UNRECORDED_TOOL_CALL } from "@hobbots/agents";
import type { PolicyEngine } from "@hobbots/permissions";
import { type Duration, Effect } from "effect";
import { type CallDecision, decideCall, startCall, type ToolCall, UNKNOWN_TOOL } from "../approval.ts";
import type { ToolTurn } from "../claude-code.ts";
import { commandOf, simpleCommands, toolLabel } from "../tool-calls.ts";
import type { CodexTurnEvents } from "./events.ts";
import type { FileUpdateChange, TurnServerRequest } from "./protocol.ts";

/** The approval requests the policy decides: a command, or a file change (ADR 024). */
export type PolicyRequest = Extract<
  TurnServerRequest,
  { readonly method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" }
>;

/** The methods of `PolicyRequest`. */
export const POLICY_REQUESTS: ReadonlyArray<PolicyRequest["method"]> = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
];

/** What the policy gate needs of the turn: its events, and how it reports a call. */
export interface PolicyTurn {
  readonly events: CodexTurnEvents;
  readonly report: (event: RuntimeEvent) => void;
}

/** Why typing into a command that is already running is refused. */
export const STDIN_REFUSED =
  "Hobbots does not let a hob type into a command that is already running. Run the command with its input instead.";

/** Why a file change is refused when Codex never said which files it touches. */
export const UNKNOWN_PATCH = "Hobbots could not tell which files this change touches, so it did not run.";

/** The shells Codex wraps a command in. */
const SHELLS = new Set(["bash", "zsh", "sh"]);

/**
 * The script a command runs. Codex starts each command as `<shell> -lc <script>` and reports that
 * argument list joined and quoted as one line, so the policy decides the script inside. Any other
 * line is decided as it is.
 */
export const shellScript = (line: string): string => {
  const commands = simpleCommands(line);
  const words = commands[0];
  if (commands.length !== 1 || words === undefined || words.length !== 3) return line;
  const [shell = "", flag, script = ""] = words;
  return SHELLS.has(basename(shell)) && (flag === "-lc" || flag === "-c") ? script : line;
};

/** A file change as Hobbots decides and records it: each file, how it changes, and the diff. */
const patchInput = (changes: ReadonlyArray<FileUpdateChange>): Record<string, unknown> => ({
  changes: changes.map((change) => ({
    path: change.path,
    kind: change.kind.type,
    ...(change.kind.type === "update" && change.kind.move_path ? { move_path: change.kind.move_path } : {}),
    diff: change.diff,
  })),
});

/** Codex's answer to an approval request: run the call, or decline it so the turn goes on. */
type Answer = { readonly decision: "accept" | "decline" };
const ACCEPT: Answer = { decision: "accept" };
const DECLINE: Answer = { decision: "decline" };

/**
 * Decides the commands and file changes Codex asks about with the hob's policy, as Claude Code's
 * hooks do (ADR 014, ADR 024). Allow records the call with `recordToolStart` and accepts it; a call
 * that could not be recorded is declined (EX-004). Ask reports `ToolAwaitingApproval` and waits for
 * the user, then decides the call again (PE-008). Never declines, reporting the reason. A declined
 * call reaches the model as rejected; the reason stays in the reply's step.
 */
export const policyGate =
  (
    engine: PolicyEngine["Service"],
    tools: ToolTurn,
    request: PromptRequest,
    sandboxed: boolean,
    /** How long a file change's approval waits for Codex to say which files it touches. */
    patchWait: Duration.Input = "5 seconds",
  ): ((asked: PolicyRequest, turn: PolicyTurn) => Effect.Effect<Answer>) =>
  (asked, turn) => {
    const label = (call: ToolCall) => toolLabel(call.tool, call.input, request.redaction?.text);
    const refuse = (call: ToolCall, decision: CallDecision) =>
      Effect.sync(() => {
        turn.report({
          _tag: "ToolDenied",
          id: call.id,
          tool: call.tool,
          // An unknown tool is refused as anything outside what the hob may do.
          operation: decision.verdict?.operation ?? "outside-folders",
          targets: decision.verdict?.targets ?? [],
          label: label(call),
          reason: decision._tag === "Refuse" ? decision.reason : "",
          decidedBy: decision._tag === "Refuse" && decision.decidedBy === "user" ? "user" : "policy",
        });
        return DECLINE;
      });
    const reason = (text: string): CallDecision => ({ _tag: "Refuse", verdict: undefined, reason: text });

    const decide = (call: ToolCall) =>
      Effect.gen(function* () {
        const decision = yield* decideCall(
          engine,
          tools.context,
          request.approvals,
          call,
          turn.report,
          request.redaction,
          tools.steersPush,
        ).pipe(Effect.catchCause(() => Effect.succeed(reason(UNKNOWN_TOOL(call.tool)))));
        if (decision._tag !== "Run") return yield* refuse(call, decision);
        const { verdict } = decision;
        // A command's folder is the one its call was decided on. Codex streams its output (ADR 023).
        const command = commandOf(call.tool, call.input, verdict.targets[0] ?? call.cwd, sandboxed, true);
        const recorded = yield* startCall(request.recordToolStart, turn.report, {
          _tag: "ToolStarted",
          id: call.id,
          tool: call.tool,
          operation: verdict.operation,
          targets: verdict.targets,
          label: label(call),
          ...(command === undefined ? {} : { command }),
        });
        if (!recorded) return yield* refuse(call, { _tag: "Refuse", verdict, reason: UNRECORDED_TOOL_CALL });
        turn.events.started(call.id);
        return ACCEPT;
      });

    const folder = tools.folders[0] as string;
    if (asked.method === "item/commandExecution/requestApproval") {
      const { itemId, command, cwd, kind } = asked.params;
      const call: ToolCall = {
        id: itemId,
        tool: "Bash",
        input: command ? { command: shellScript(command) } : {},
        cwd: cwd ?? folder,
      };
      return kind === "writeStdin" ? refuse(call, reason(STDIN_REFUSED)) : decide(call);
    }
    const { itemId } = asked.params;
    return turn.events.changes(itemId, patchWait).pipe(
      Effect.flatMap((changes) => {
        const call: ToolCall = {
          id: itemId,
          tool: "apply_patch",
          input: patchInput(changes ?? []),
          cwd: folder,
        };
        return changes === undefined || changes.length === 0 ? refuse(call, reason(UNKNOWN_PATCH)) : decide(call);
      }),
    );
  };
