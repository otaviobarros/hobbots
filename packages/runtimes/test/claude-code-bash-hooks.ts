/**
 * What Claude Code 2.1.311 (the binary Agent SDK 0.3.311 runs) gave its PostToolUse and
 * PostToolUseFailure hooks for four Bash commands, recorded from a real run with command hooks that
 * saved their input. Only the fields Hobbots reads are kept; the session, transcript and folder are
 * left out.
 */
export const RECORDED_BASH_HOOKS = {
  false: {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "false", description: "Run false" },
    error: "Exit code 1",
    is_interrupt: false,
  },
  true: {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "true", description: "Run true" },
    tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
  },
  grepNoMatch: {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "grep zzz /dev/null", description: "Run grep on empty file" },
    tool_response: {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      returnCodeInterpretation: "No matches found",
      noOutputExpected: false,
    },
  },
  printsThenExits2: {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: {
      command: "echo before; echo oops >&2; exit 2",
      description: "Print to stdout and stderr, then exit 2",
    },
    error: "Exit code 2\nbefore\noops",
    is_interrupt: false,
  },
} as const;
