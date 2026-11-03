import type { RuntimeEvent } from "@hobbots/agents";

/**
 * How a Claude Code tool call ended, from what its PostToolUse or PostToolUseFailure hook gets, with
 * a Bash command's exit code.
 *
 * Claude Code reports no exit code field. A command that exits non-zero fails the call, and the
 * failure's `error` starts with the line `Exit code N`, followed by what the command printed (the
 * hooks reference, "PostToolUseFailure input"). A command whose call succeeds exited 0, unless
 * Claude Code read a non-zero code as no error, which it says in `returnCodeInterpretation` (grep's
 * "No matches found") without the code itself. An interrupted or backgrounded command has no exit
 * code yet either.
 */

/** What a call's hook says about how it ended. */
export type HookEnd =
  | { readonly hook_event_name: "PostToolUse"; readonly tool_name: string; readonly tool_response: unknown }
  | {
      readonly hook_event_name: "PostToolUseFailure";
      readonly tool_name: string;
      readonly error: string;
      readonly is_interrupt?: boolean;
    };

const EXIT_LINE = /^Exit code (\d+)(?:\n|$)/;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;

/** The exit code of a Bash command whose call succeeded, or undefined when Claude Code did not say it. */
const succeededExit = (response: unknown): number | undefined =>
  field(response, "interrupted") === false &&
  field(response, "backgroundTaskId") === undefined &&
  field(response, "returnCodeInterpretation") === undefined
    ? 0
    : undefined;

/**
 * The `ToolFinished` event a call's hook reports, with `output` what the call printed (for a failure,
 * its error). A Bash failure's `Exit code N` line becomes `exitCode` and leaves the output.
 */
export const toolFinished = (id: string, end: HookEnd, output: string | undefined): RuntimeEvent => {
  const failed = end.hook_event_name === "PostToolUseFailure";
  const bash = end.tool_name === "Bash";
  const exit = bash && failed && end.is_interrupt !== true ? EXIT_LINE.exec(output ?? "") : null;
  const exitCode = exit !== null ? Number(exit[1]) : bash && !failed ? succeededExit(end.tool_response) : undefined;
  const printed = exit === null ? output : (output ?? "").slice(exit[0].length);
  return {
    _tag: "ToolFinished",
    id,
    failed,
    ...(printed === undefined || (exit !== null && printed === "") ? {} : { output: printed }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
};
