import { RuntimeHealth, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Effect, Exit, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, type RuntimeEvent } from "./adapter.ts";

/**
 * The fake runtime's models: a main one with every effort level, and one behind "More models"
 * that takes none.
 */
export const fakeModels = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  models: [
    new RuntimeModel({
      id: "fake-thinker",
      displayName: "Fake Thinker",
      description: "Echoes prompts; accepts every effort level",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      main: true,
    }),
    new RuntimeModel({
      id: "fake-quick",
      displayName: "Fake Quick",
      description: "Echoes prompts; takes no effort setting",
      efforts: [],
      main: false,
    }),
  ],
});

export interface FakeRuntimeOptions {
  /** Pause before each event, so a reply streams visibly. */
  readonly delay?: string;
  /** How long a cancelled turn takes to end, like a real runtime shutting a turn down. */
  readonly stopDelay?: string;
}

/** Deterministic adapter for tests and UI work without model usage. */
export const makeFakeRuntime = (options: FakeRuntimeOptions = {}) => {
  const sendPrompt = (request: PromptRequest) => {
    const sessionId = request.sessionId ?? `fake-${crypto.randomUUID()}`;
    const reply = `Echo: ${request.prompt}`;
    const words = reply.split(/(?<= )/);
    const events: Array<RuntimeEvent> = [
      { _tag: "SessionStarted", sessionId, billing: "fake" },
      ...words.map((text): RuntimeEvent => ({ _tag: "TextDelta", text })),
      { _tag: "Completed", sessionId, text: reply },
    ];
    const stream = Stream.fromIterable(events);
    const paced = options.delay ? stream.pipe(Stream.tap(() => Effect.sleep(options.delay as "10 millis"))) : stream;
    return options.stopDelay
      ? paced.pipe(
          Stream.onExit((exit) =>
            Exit.hasInterrupts(exit) ? Effect.sleep(options.stopDelay as "10 millis") : Effect.void,
          ),
        )
      : paced;
  };

  return RuntimeAdapter.of({
    health: Effect.succeed(
      new RuntimeHealth({
        runtime: "claude-code",
        availability: "ready",
        billing: "fake",
        version: "fake",
        detail: "Fake runtime (no model calls)",
        checkedAt: null,
      }),
    ),
    models: Effect.succeed(fakeModels),
    sendPrompt,
  });
};

export const FakeRuntimeLayer = (options?: FakeRuntimeOptions) =>
  Layer.succeed(RuntimeAdapter, makeFakeRuntime(options));
