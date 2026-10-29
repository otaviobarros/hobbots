import { RuntimeHealth, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Effect, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, type RuntimeEvent } from "./adapter.ts";

/** The fake runtime's models: one with every effort level and one that takes none. */
export const fakeModels = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  models: [
    new RuntimeModel({
      id: "fake-thinker",
      displayName: "Fake Thinker",
      description: "Echoes prompts; accepts every effort level",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    }),
    new RuntimeModel({
      id: "fake-quick",
      displayName: "Fake Quick",
      description: "Echoes prompts; takes no effort setting",
      efforts: [],
    }),
  ],
});

/** Deterministic adapter for tests and UI work without model usage. */
export const makeFakeRuntime = (options: { readonly delay?: string } = {}) => {
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
    return options.delay ? stream.pipe(Stream.tap(() => Effect.sleep(options.delay as "10 millis"))) : stream;
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

export const FakeRuntimeLayer = (options?: { readonly delay?: string }) =>
  Layer.succeed(RuntimeAdapter, makeFakeRuntime(options));
