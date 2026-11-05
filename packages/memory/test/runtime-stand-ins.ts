import {
  AdditionalRuntimes,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  type RuntimeError,
  type RuntimeEvent,
  type RuntimeLimitReached,
} from "@hobbots/agents";
import { type RuntimeKind, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Effect, Layer, Stream } from "effect";

// Claude Code and Codex as the memory model endpoint sees them (ADR 028): adapters that record each
// turn and answer as told, with the models each runtime reports.

export type Answer =
  | { readonly _tag: "Reply"; readonly text: string }
  | { readonly _tag: "Fail"; readonly error: unknown };

/** An adapter that records each turn and answers what `answer` holds, as a runtime would. */
const recordingAdapter = (runtime: RuntimeKind, models: RuntimeModels) => {
  const turns: Array<PromptRequest> = [];
  let answer: Answer = { _tag: "Reply", text: "Done." };
  const adapter: RuntimeAdapterShape = {
    health: Effect.die("not read here"),
    models: Effect.succeed(models),
    enforcement: Effect.die("not read here"),
    sendPrompt: (request) => {
      turns.push(request);
      if (answer._tag === "Fail") return Stream.fail(answer.error as RuntimeError | RuntimeLimitReached);
      const events: ReadonlyArray<RuntimeEvent> = [
        { _tag: "SessionStarted", sessionId: `${runtime}-session`, billing: "subscription" },
        { _tag: "TextDelta", text: answer.text },
        {
          _tag: "Completed",
          sessionId: `${runtime}-session`,
          text: answer.text,
          usage: {
            timeToRequestMs: null,
            timeToFirstStreamMs: null,
            timeToFirstTokenMs: null,
            inputTokens: 120,
            outputTokens: 8,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        },
      ];
      return Stream.fromIterable(events);
    },
  };
  return {
    adapter,
    turns,
    answer: (next: Answer) => {
      answer = next;
    },
  };
};

const model = (id: string, efforts: RuntimeModel["efforts"], main = true) =>
  new RuntimeModel({ id, displayName: id, description: "", efforts, main });

export const claude = recordingAdapter(
  "claude-code",
  new RuntimeModels({
    runtime: "claude-code",
    source: "runtime",
    small: "quick",
    models: [model("default", []), model("careful", ["low", "medium", "high"]), model("quick", [])],
  }),
);
export const codex = recordingAdapter(
  "codex",
  new RuntimeModels({
    runtime: "codex",
    source: "runtime",
    models: [model("big", ["medium", "high"]), model("small", ["low", "medium"])],
  }),
);

/** Both stand-ins as the hub's runtime adapters: Claude Code's, and Codex's beside it. */
export const standInRuntimes = Layer.mergeAll(
  Layer.succeed(RuntimeAdapter, claude.adapter),
  Layer.succeed(AdditionalRuntimes, new Map([["codex" as const, codex.adapter]])),
);

/** Back to answering every turn, with no turn recorded. */
export const resetStandIns = () => {
  for (const each of [claude, codex]) {
    each.turns.length = 0;
    each.answer({ _tag: "Reply", text: "Done." });
  }
};
