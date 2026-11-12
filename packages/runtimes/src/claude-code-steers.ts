import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { TurnSteers } from "@hobbots/agents";
import { Effect } from "effect";
import { mergeHooks } from "./hub-tools.ts";

/**
 * The hook that hands a running Claude Code turn the messages that wait for it (#1345). It runs as
 * each tool call ends, and adds them to that call's result as context, so the model reads them
 * before its next step and never inside a call. A call that waits for your approval ends only once
 * you decide it, so its card stays and the message follows it. A subagent's call is left alone,
 * since only the turn's own model should read them.
 */
const handOver =
  (steers: TurnSteers): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    if (input.agent_id !== undefined) return {};
    let handed: string | undefined;
    await Effect.runPromise(
      steers.deliver((text) =>
        Effect.sync(() => {
          handed = text;
          return true;
        }),
      ),
    );
    return handed === undefined
      ? {}
      : { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: handed } };
  };

/** A turn's options with the hook that hands it the messages that reach it while it runs (#1345). */
export const withSteers = (options: Options, steers: TurnSteers | null | undefined): Options => {
  if (!steers) return options;
  const hook = handOver(steers);
  return {
    ...options,
    hooks: mergeHooks(options.hooks, {
      PostToolUse: [{ hooks: [hook] }],
      PostToolUseFailure: [{ hooks: [hook] }],
    }),
  };
};
