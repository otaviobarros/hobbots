import type { HubCallStep, TaskToolCalls } from "@hobbots/agents";
import { type EventEnvelope, stableJson, type TaskId, type TaskToolRefused } from "@hobbots/domain";
import { DateTime, Effect } from "effect";

/** Who made a refused call and what it sent, as far as the hub could read it. */
export interface RefusedFrom {
  readonly agentId: Parameters<TaskToolCalls["Service"]["refused"]>[0]["agentId"];
  readonly tool: string;
  readonly raw: unknown;
  /** The Task the calling turn worked on, read once the call is refused: a chat turn learns it during the call. */
  readonly taskOf: () => TaskId | null;
}

/** The key a call sent, when it sent one the ledger could have used. */
const keyOf = (raw: unknown): string | null => {
  const key = raw !== null && typeof raw === "object" ? (raw as { readonly key?: unknown }).key : undefined;
  return typeof key === "string" && key !== "" && key.length <= 200 ? key : null;
};

/** The call's input without its key, as stable JSON; `null` for input that is not JSON at all. */
const inputOf = (raw: unknown): string => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const { key: _key, ...rest } = raw as Record<string, unknown>;
    return stableJson(rest);
  }
  return stableJson(raw) ?? "null";
};

/**
 * Records every refusal of a Task tool call, whatever refused it: the call's own checks, the
 * ledger, or a tool the turn does not offer (#575). The refusal is journaled and announced, then
 * returned unchanged. A refusal that cannot be recorded is logged, and the hob still reads it.
 */
export const makeRefusals = (
  ledger: TaskToolCalls["Service"],
  announce: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>,
) => {
  const record = (from: RefusedFrom, refused: TaskToolRefused) =>
    Effect.gen(function* () {
      const committed = yield* ledger.refused({
        agentId: from.agentId,
        key: keyOf(from.raw),
        tool: from.tool,
        input: inputOf(from.raw),
        taskId: from.taskOf(),
        refused,
        at: DateTime.formatIso(yield* DateTime.now),
      });
      yield* announce(committed.entries);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not record a refused Task tool call", cause)));

  return {
    /** `made`, with its refusal recorded. */
    recorded:
      (from: RefusedFrom) =>
      <A, R>(made: Effect.Effect<A, TaskToolRefused, R>): Effect.Effect<A, TaskToolRefused, R> =>
        made.pipe(Effect.tapError((refused) => record(from, refused))),
  };
};

/**
 * Ends a refused call's reply step as failed, with why, so the reply shows the refusal (#575). A
 * runtime ends the step after the call returns, which keeps it failed.
 */
export const showRefusal = (step: HubCallStep | undefined, why: string): void => {
  step?.report({ _tag: "ToolFinished", id: step.id, failed: true, output: why });
};
