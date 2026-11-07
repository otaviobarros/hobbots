import { type HubTools, hubCallStep, type PromptRequest, type RuntimeEvent } from "@hobbots/agents";
import { Effect, Fiber } from "effect";
import type { CodexTurnEvents } from "./events.ts";
import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec } from "./protocol.ts";

/**
 * The turn's hub tools as Codex dynamic tools (ADR 024), declared when a Codex thread starts. Codex
 * keeps the tools a thread started with: a resumed thread ignores new ones, so the hub decides
 * every call against the turn's own tools, never against what the thread was offered.
 */
export const dynamicToolsOf = (hub: HubTools | null | undefined): ReadonlyArray<DynamicToolSpec> =>
  (hub?.tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

/** Why a hub tool call is refused on a turn that offers no hub tools, as a resumed thread may still call one. */
export const notOffered = (tool: string) =>
  `${tool} is not offered in this turn, so it did not run. Use the tools you were given.`;

/** What a hub tool call is given about the turn: its events, how it reports a step and how it records a call. */
export interface HubToolTurn {
  readonly events: CodexTurnEvents;
  readonly report: (event: RuntimeEvent) => void;
  readonly record: PromptRequest["recordToolStart"];
}

/**
 * Answers a Codex `item/tool/call` through the hub, which decides it (ADR 024): the call shows as a
 * step from the moment Codex asks, and the hub is given that step, so a call that needs the user's
 * approval waits on it. The step ends with Codex's own record of the call (`item/completed`), so a
 * Codex that stops before it recorded the answer leaves the call uncertain (EX-004).
 *
 * The call runs to its end once the hub has it, as on Claude Code: a Codex that stops, or a turn
 * that is cancelled, stops waiting for the answer but never cuts a hub write off halfway.
 */
export const callHubTool = (
  hub: HubTools | null | undefined,
  params: DynamicToolCallParams,
  turn: HubToolTurn,
): Effect.Effect<DynamicToolCallResponse> =>
  Effect.gen(function* () {
    const { callId, tool } = params;
    const label = hub?.tools.find((offered) => offered.name === tool)?.label ?? `Using ${tool}`;
    turn.report({ _tag: "StepStarted", id: callId, kind: "tool", label });
    turn.events.started(callId);
    const answer =
      hub == null
        ? { text: notOffered(tool), refused: true }
        : yield* Fiber.join(
            yield* Effect.forkDetach(
              hub.call(tool, params.arguments ?? {}, hubCallStep(callId, turn.report, turn.record)),
            ),
          );
    return { contentItems: [{ type: "inputText", text: answer.text }], success: !answer.refused };
  });
