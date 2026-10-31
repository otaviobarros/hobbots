import { type RuntimeAvailability, RuntimeHealth, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Clock, Effect, Exit, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, RuntimeError, type RuntimeEvent, RuntimeLimitReached } from "./adapter.ts";

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
  /** What the health check reports, to show a brain that cannot think (ready by default). */
  readonly availability?: RuntimeAvailability;
}

/**
 * Prompts that make the fake runtime end a turn the way a provider can, so every chat state can be
 * reached without a model. Only a prompt that starts with one counts.
 */
export const FAKE_DIRECTIVES = {
  /** Writes a little, then stops responding: the reply is cut off. */
  cutOff: "fake:cut-off",
  /** Writes a little, then hits the usage limit, which refills in an hour. */
  limit: "fake:limit",
} as const;

/** What the fake says when it cuts a reply off. */
export const fakeCutOffError = "Claude stopped responding";

/** Deterministic adapter for tests and UI work without model usage. */
export const makeFakeRuntime = (options: FakeRuntimeOptions = {}) => {
  const availability = options.availability ?? "ready";
  const sendPrompt = (request: PromptRequest): Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached> => {
    // A brain that is not ready cannot start a turn, as with the real runtime.
    if (availability !== "ready") {
      return Stream.fail(new RuntimeError({ message: `Fake runtime is ${availability}` }));
    }
    const sessionId = request.sessionId ?? `fake-${crypto.randomUUID()}`;
    const reply = `Echo: ${request.prompt}`;
    const words = reply.split(/(?<= )/);
    const ending = request.prompt.startsWith(FAKE_DIRECTIVES.cutOff)
      ? "cutOff"
      : request.prompt.startsWith(FAKE_DIRECTIVES.limit)
        ? "limit"
        : "complete";
    const events: Array<RuntimeEvent> = [
      { _tag: "SessionStarted", sessionId, billing: "fake" },
      // Every reply thinks first, so the step display can be seen and tested.
      { _tag: "StepStarted", id: "thinking-1", kind: "thinking", label: "Thinking" },
      { _tag: "StepEnded", id: "thinking-1" },
      ...(ending === "complete" ? words : words.slice(0, 2)).map((text): RuntimeEvent => ({ _tag: "TextDelta", text })),
      ...(ending === "complete" ? [{ _tag: "Completed", sessionId, text: reply } as const] : []),
    ];
    const failure: Stream.Stream<never, RuntimeError | RuntimeLimitReached> =
      ending === "cutOff"
        ? Stream.fail(new RuntimeError({ message: fakeCutOffError }))
        : ending === "limit"
          ? Stream.unwrap(
              Effect.map(Clock.currentTimeMillis, (now) =>
                Stream.fail(new RuntimeLimitReached({ resetsAt: new Date(now + 60 * 60 * 1000).toISOString() })),
              ),
            )
          : Stream.empty;
    const stream = Stream.fromIterable(events).pipe(Stream.concat(failure));
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
        availability,
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
