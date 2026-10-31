import {
  type PromptRequest,
  RuntimeAdapter,
  RuntimeError,
  type RuntimeEvent,
  RuntimeLimitReached,
} from "@hobbots/agents";
import {
  type RuntimeAvailability,
  type RuntimeEnforcement,
  RuntimeHealth,
  RuntimeModel,
  RuntimeModels,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Clock, Effect, Exit, Layer, Option, Stream } from "effect";
import { refusal, toolTurn, UNKNOWN_TOOL } from "./claude-code.ts";
import { narrowestVerdict, toolLabel, toolRequests } from "./tool-calls.ts";

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
  /** Whether the fake pretends its sandbox started ("on", the default) or cannot start on this hub. */
  readonly sandbox?: "on" | "unavailable";
  /** Decides scripted tool calls; without it a turn has no tools. */
  readonly engine?: PolicyEngine["Service"];
}

/** What the fake runtime claims to enforce. Nothing is run, so its claims are about decisions only. */
export const fakeEnforcement = (sandbox: "on" | "unavailable"): RuntimeEnforcement => ({
  toolInterception: {
    status: "verified",
    evidence: "The fake decides every scripted tool call with the policy engine.",
  },
  processSandbox:
    sandbox === "on"
      ? { status: "verified", evidence: "The fake pretends its sandbox started." }
      : { status: "unsupported", evidence: "The fake pretends the sandbox cannot start on this hub." },
  hubTools: { status: "unsupported", evidence: "Charms and coordination tools are not served yet." },
  toolEvents: { status: "verified", evidence: "The fake reports each scripted call's start, finish or denial." },
  toolInterruption: { status: "verified", evidence: "Cancelling the turn ends the fake's stream." },
});

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
 * The tool calls a prompt scripts, decided by the policy engine as Claude Code's would be: each is
 * reported as started and finished, or denied. Nothing is read, written or run.
 */
export const scriptedToolEvents = (
  request: PromptRequest,
  engine: PolicyEngine["Service"] | undefined,
  sandbox: "on" | "unavailable" = "on",
): Effect.Effect<ReadonlyArray<RuntimeEvent>> =>
  Effect.gen(function* () {
    // Commands are decided as on a hub where the sandbox started, or where it cannot start.
    const turn = engine ? toolTurn(request.tools, sandbox) : null;
    if (engine === undefined || turn === null) return [];
    const calls = request.prompt
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${FAKE_TOOL_DIRECTIVE} `))
      .map((line) => {
        const [tool = "", ...rest] = line
          .slice(FAKE_TOOL_DIRECTIVE.length + 1)
          .trim()
          .split(" ");
        return { tool, input: scriptedInput(tool, rest.join(" ")) };
      });
    const events: Array<RuntimeEvent> = [];
    for (const [index, { tool, input }] of calls.entries()) {
      const id = `fake-tool-${index + 1}`;
      const label = toolLabel(tool, input);
      const requests = toolRequests(tool, input, turn.folders[0] as string);
      // Like Claude Code, an unknown tool is refused, and a known one not offered this turn is never called.
      if (requests === null) {
        events.push({
          _tag: "ToolDenied",
          id,
          tool,
          operation: "outside-folders",
          targets: [],
          label,
          reason: UNKNOWN_TOOL(tool),
          decidedBy: "policy",
        });
        continue;
      }
      if (!turn.tools.includes(tool)) continue;
      const verdict = narrowestVerdict(yield* Effect.forEach(requests, (r) => engine.decide(turn.context, r)));
      if (verdict === undefined) continue;
      if (verdict.decision === "allow") {
        events.push(
          { _tag: "ToolStarted", id, tool, operation: verdict.operation, targets: verdict.targets, label },
          { _tag: "ToolFinished", id, failed: false },
        );
      } else {
        events.push({
          _tag: "ToolDenied",
          id,
          tool,
          operation: verdict.operation,
          targets: verdict.targets,
          label,
          reason: refusal(verdict),
          decidedBy: "policy",
        });
      }
    }
    return events;
  });

/**
 * Deterministic adapter for tests and UI work without model usage. Like Claude Code, a resumed session
 * keeps the instructions it started with unless the turn carries changed ones.
 */
export const makeFakeRuntime = (options: FakeRuntimeOptions = {}) => {
  const availability = options.availability ?? "ready";
  const sandbox = options.sandbox ?? "on";
  const enforcement = fakeEnforcement(sandbox);
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
    const stream = Stream.unwrap(
      Effect.map(scriptedToolEvents(request, options.engine, sandbox), (tools) =>
        // Tool calls come after the thinking step, before the reply is written.
        Stream.fromIterable([...events.slice(0, 3), ...tools, ...events.slice(3)]),
      ),
    ).pipe(Stream.concat(failure));
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
        enforcement,
      }),
    ),
    models: Effect.succeed(fakeModels),
    enforcement: Effect.succeed(enforcement),
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
