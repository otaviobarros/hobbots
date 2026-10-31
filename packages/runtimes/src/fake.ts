import {
  type PromptRequest,
  RuntimeAdapter,
  RuntimeError,
  type RuntimeEvent,
  RuntimeLimitReached,
} from "@hobbots/agents";
import { type RuntimeAvailability, RuntimeHealth, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Clock, Effect, Exit, Layer, Option, Queue, Stream } from "effect";
import { decideCall } from "./approval.ts";
import { toolTurn } from "./claude-code.ts";
import { toolLabel, toolRequests } from "./tool-calls.ts";

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
  /** Decides scripted tool calls; without it a turn has no tools. */
  readonly engine?: PolicyEngine["Service"];
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

/** Asked this, the fake runtime answers with the instructions its session follows instead of an echo. */
export const fakeInstructionsPrompt = "/instructions";

/** A prompt line `fake:tool <Tool> <argument>` asks the fake runtime to make that tool call. */
export const FAKE_TOOL_DIRECTIVE = "fake:tool";

const scriptedInput = (tool: string, argument: string): Record<string, unknown> => {
  switch (tool) {
    case "Bash":
      return { command: argument };
    case "Glob":
    case "Grep":
      return { pattern: argument };
    case "NotebookEdit":
      return { notebook_path: argument };
    default:
      return { file_path: argument };
  }
};

/**
 * The tool calls a prompt scripts, decided as Claude Code's would be: by the policy engine, and for
 * Ask by the user through the turn's approvals. Each is reported as started and finished, or denied.
 * Nothing is read, written or run.
 */
export const scriptedToolEvents = (
  request: PromptRequest,
  engine: PolicyEngine["Service"] | undefined,
): Stream.Stream<RuntimeEvent> => {
  // The fake pretends its sandbox started, so commands are decided as on a supported hub.
  const turn = engine ? toolTurn(request.tools, "on") : null;
  if (engine === undefined || turn === null) return Stream.empty;
  const calls = request.prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${FAKE_TOOL_DIRECTIVE} `))
    .map((line, index) => {
      const [tool = "", ...rest] = line
        .slice(FAKE_TOOL_DIRECTIVE.length + 1)
        .trim()
        .split(" ");
      return {
        id: `fake-tool-${index + 1}`,
        tool,
        input: scriptedInput(tool, rest.join(" ")),
        cwd: turn.folders[0] as string,
      };
    })
    // Like Claude Code, a known tool not offered this turn is never called; an unknown one is refused.
    .filter((call) => toolRequests(call.tool, call.input, call.cwd) === null || turn.tools.includes(call.tool));
  return Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) =>
      Stream.callback<RuntimeEvent>((queue) =>
        Effect.gen(function* () {
          const decision = yield* decideCall(engine, turn.context, request.approvals, call, (event) =>
            Queue.offerUnsafe(queue, event),
          );
          const label = toolLabel(call.tool, call.input);
          if (decision._tag === "Run") {
            const { operation, targets } = decision.verdict;
            yield* Queue.offer(queue, { _tag: "ToolStarted", id: call.id, tool: call.tool, operation, targets, label });
            yield* Queue.offer(queue, { _tag: "ToolFinished", id: call.id, failed: false });
          } else {
            yield* Queue.offer(queue, {
              _tag: "ToolDenied",
              id: call.id,
              tool: call.tool,
              operation: decision.verdict?.operation ?? "outside-folders",
              targets: decision.verdict?.targets ?? [],
              label,
              reason: decision.reason,
              decidedBy: decision.decidedBy ?? "policy",
            });
          }
          yield* Queue.end(queue);
        }),
      ),
    ),
  );
};

/**
 * Deterministic adapter for tests and UI work without model usage. Like Claude Code, a resumed session
 * keeps the instructions it started with unless the turn carries changed ones.
 */
export const makeFakeRuntime = (options: FakeRuntimeOptions = {}) => {
  const availability = options.availability ?? "ready";
  const sessions = new Map<string, string>();
  const sendPrompt = (request: PromptRequest): Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached> => {
    // A brain that is not ready cannot start a turn, as with the real runtime.
    if (availability !== "ready") {
      return Stream.fail(new RuntimeError({ message: `Fake runtime is ${availability}` }));
    }
    const sessionId = request.sessionId ?? `fake-${crypto.randomUUID()}`;
    const known = sessions.get(sessionId);
    const followed = known === undefined || request.instructionsChanged ? request.instructions : known;
    sessions.set(sessionId, followed);
    const reply = request.prompt === fakeInstructionsPrompt ? followed : `Echo: ${request.prompt}`;
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
    // Tool calls come after the thinking step, before the reply is written.
    const stream = Stream.fromIterable(events.slice(0, 3)).pipe(
      Stream.concat(scriptedToolEvents(request, options.engine)),
      Stream.concat(Stream.fromIterable(events.slice(3))),
      Stream.concat(failure),
    );
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

/** The fake runtime, deciding scripted tool calls with the hub's policy engine when there is one. */
export const FakeRuntimeLayer = (options?: FakeRuntimeOptions) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.map(Effect.serviceOption(PolicyEngine), (engine) =>
      makeFakeRuntime({ ...options, ...(Option.isSome(engine) ? { engine: engine.value } : {}) }),
    ),
  );
