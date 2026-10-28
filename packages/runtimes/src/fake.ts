import { RuntimeHealth } from "@hobbots/domain";
import { Effect, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, type RuntimeEvent } from "./adapter.ts";

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
    sendPrompt,
  });
};

export const FakeRuntimeLayer = (options?: { readonly delay?: string }) =>
  Layer.succeed(RuntimeAdapter, makeFakeRuntime(options));
