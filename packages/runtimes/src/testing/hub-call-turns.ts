import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type {
  HubTools,
  PromptRequest,
  RuntimeError,
  RuntimeEvent,
  RuntimeLimitReached,
  ToolStartedEvent,
  TurnApprovals,
} from "@hobbots/agents";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, type Exit, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { makeClaudeCode } from "../claude-code.ts";
import { startAppServer } from "../codex/app-server.ts";
import { type CodexTurnConfig, runCodexTurn } from "../codex/turn.ts";
import { FAKE_HUB_DIRECTIVE, makeFakeRuntime } from "../fake.ts";
import { ProcessSandbox } from "../sandbox.ts";
import { messagesStandIn } from "./messages-stand-in.ts";
import { functionCall, standIn } from "./responses-stand-in.ts";

/**
 * Turns that make scripted hub tool calls on each runtime Hobbots serves hub tools on (ADR 031): the
 * fake runtime always, and an installed Claude Code or Codex when `HOBBOTS_CLAUDE_CODE` or
 * `HOBBOTS_CODEX` names its binary. Claude Code and Codex talk to a stand-in model that makes the
 * calls, so no account or real model is used. A suite in another package hands a turn its own hub
 * tools, such as the Memory or Skill tools, and sees how each runtime calls them.
 */

/** A hub tool call the turn makes, in order. */
export interface ScriptedHubCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface HubCallTurn {
  readonly hubTools: HubTools;
  readonly recordToolStart: (event: ToolStartedEvent) => Effect.Effect<boolean>;
  readonly calls: ReadonlyArray<ScriptedHubCall>;
  readonly approvals?: TurnApprovals;
}

export interface HubCallRuntime {
  readonly name: "fake" | "claude-code" | "codex";
  /** Runs one turn that makes `calls`, then ends. */
  readonly turn: (turn: HubCallTurn) => Promise<{ readonly exit: Exit.Exit<unknown, unknown> }>;
  /**
   * The events of one turn that makes `calls` with what a hub hands `request`: its hub tools, its
   * step recorder, its approvals and its redactor. So a whole hub can run its turns on this runtime.
   */
  readonly events: (
    request: PromptRequest,
    calls: ReadonlyArray<ScriptedHubCall>,
  ) => Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached>;
  /**
   * Every text the turns' model was sent so far, in order: the briefing and prompt the fake was
   * handed, or each string in the requests the stand-in model received, its instructions, prompt,
   * tools and tool results among them. So a suite can see what reached the model, not only the hub.
   */
  readonly modelText: () => ReadonlyArray<string>;
  /** Each request the turns' model was sent so far, in order, as one text: what `modelText` reads, per request. */
  readonly modelRequests: () => ReadonlyArray<string>;
  readonly close: () => void;
}

/** Marks the turn's own model requests, apart from a runtime's side questions. */
const INSTRUCTIONS = "You are Pip, a hob making scripted hub calls.";

/**
 * The turn's own request: only what a hub hands it for hub calls and its briefing, the context block
 * that carries the roster of other hobs (ADR 032), so a runtime starts no sandbox, resumes no session
 * and reaches only its stand-in model.
 */
const scripted = (
  request: Pick<PromptRequest, "hubTools" | "recordToolStart" | "approvals" | "redaction"> &
    Partial<Pick<PromptRequest, "briefing" | "steers">>,
) =>
  ({
    prompt: "Make the scripted calls.",
    briefing: request.briefing ?? null,
    sessionId: null,
    instructions: INSTRUCTIONS,
    instructionsChanged: false,
    model: null,
    effort: null,
    ephemeral: true,
    hubTools: request.hubTools ?? null,
    recordToolStart: request.recordToolStart ?? null,
    ...(request.approvals == null ? {} : { approvals: request.approvals }),
    ...(request.redaction == null ? {} : { redaction: request.redaction }),
    ...(request.steers == null ? {} : { steers: request.steers }),
  }) satisfies PromptRequest;

const base = (turn: HubCallTurn): PromptRequest =>
  scripted({
    hubTools: turn.hubTools,
    recordToolStart: turn.recordToolStart,
    ...(turn.approvals === undefined ? {} : { approvals: turn.approvals }),
  });

const collect = (events: Stream.Stream<RuntimeEvent, unknown>) =>
  Effect.runPromise(Stream.runCollect(events).pipe(Effect.exit)).then((exit) => ({ exit }));

/** Every string in a model request, depth first, so what reached the model reads as plain text. */
const strings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
};

/** A runtime whose `events` makes the calls, with `turn` running them to the end. */
const hubCallRuntime = (
  name: HubCallRuntime["name"],
  events: HubCallRuntime["events"],
  modelRequests: ReadonlyArray<unknown>,
  close: () => void,
): HubCallRuntime => ({
  name,
  events,
  turn: (turn) => collect(events(base(turn), turn.calls)),
  modelText: () => modelRequests.flatMap(strings),
  modelRequests: () => modelRequests.map((request) => strings(request).join("\n")),
  close,
});

const fakeRuntime = (): HubCallRuntime => {
  const runtime = makeFakeRuntime();
  const told: Array<{ readonly briefing: string | null; readonly prompt: string }> = [];
  return hubCallRuntime(
    "fake",
    (request, calls) => {
      const sent = {
        ...scripted(request),
        prompt: calls.map((call) => `${FAKE_HUB_DIRECTIVE} ${call.tool} ${JSON.stringify(call.input)}`).join("\n"),
      };
      told.push({ briefing: sent.briefing, prompt: sent.prompt });
      return runtime.sendPrompt(sent);
    },
    told,
    () => {},
  );
};

const listen = async (server: import("node:http").Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const claudeCodeRuntime = async (executable: string, root: string): Promise<HubCallRuntime> => {
  const model = messagesStandIn(INSTRUCTIONS);
  const port = await listen(model.server);
  const home = join(root, "claude-home");
  mkdirSync(home, { recursive: true });
  const saved = { ...process.env };
  // Claude Code reads a home of its own and reaches only the stand-in.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) delete process.env[key];
  }
  process.env.HOME = home;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_AUTH_TOKEN = "stand-in";
  const adapter = await Effect.runPromise(
    makeClaudeCode({ workspaceDir: join(root, "claude-workspace"), executable }).pipe(
      Effect.provide(Layer.mergeAll(PolicyEngine.node, ProcessSandbox.unavailable("not needed for hub calls"))),
    ),
  );
  return hubCallRuntime(
    "claude-code",
    (request, calls) =>
      Stream.suspend(() => {
        model.moves.push(...calls.map((call) => ({ tool: `mcp__hobbots__${call.tool}`, input: call.input })), {
          say: "Done.",
        });
        return adapter.sendPrompt(scripted(request));
      }).pipe(Stream.ensuring(Effect.sync(() => (model.moves.length = 0)))),
    model.requests,
    () => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
      model.server.close();
    },
  );
};

const codexRuntime = async (binary: string, root: string): Promise<HubCallRuntime> => {
  const model = standIn();
  const port = await listen(model.server);
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  const { engine, spawner } = await Effect.runPromise(
    Effect.all({
      engine: Effect.service(PolicyEngine),
      spawner: Effect.service(ChildProcessSpawner.ChildProcessSpawner),
    }).pipe(Effect.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer))),
  );
  const config: CodexTurnConfig = {
    binary: Effect.succeed(binary),
    start: (command, options) =>
      startAppServer(command, options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    signIn: () => Effect.succeed(null),
    clientVersion: "0.0.0",
    workspaceDir: join(root, "codex-workspace"),
    userHome: home,
    policy: {
      engine,
      sandboxState: "on",
      sandbox: { state: "unavailable", evidence: "not started for hub calls", prepare: () => Effect.never },
    },
    extraArgs: [
      "-c",
      'model_provider="standin"',
      "-c",
      `model_providers.standin={ name = "standin", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`,
      "-c",
      'model="gpt-5.5"',
    ],
  };
  let count = 0;
  return hubCallRuntime(
    "codex",
    (request, calls) =>
      Stream.suspend(() => {
        model.moves.push(
          ...calls.map((call) => {
            count += 1;
            return functionCall(call.tool, call.input, `call-${count}`);
          }),
          { say: "Done." },
        );
        // Kept on disk, as a hob's thread is, so its rollout shows a call it was not offered (#1356).
        return runCodexTurn(config, { ...scripted(request), ephemeral: false });
      }).pipe(Stream.ensuring(Effect.sync(() => (model.moves.length = 0)))),
    model.requests,
    () => model.server.close(),
  );
};

/**
 * The runtimes a suite can run hub calls on here: the fake runtime, and Claude Code and Codex where
 * their binaries are set. `close` ends them all and removes their folders.
 */
export const hubCallRuntimes = async (): Promise<{
  readonly runtimes: ReadonlyArray<HubCallRuntime>;
  readonly close: () => void;
}> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hub-calls-")));
  const runtimes: Array<HubCallRuntime> = [fakeRuntime()];
  const claude = process.env.HOBBOTS_CLAUDE_CODE;
  const codex = process.env.HOBBOTS_CODEX;
  if (claude !== undefined) runtimes.push(await claudeCodeRuntime(claude, root));
  if (codex !== undefined) runtimes.push(await codexRuntime(codex, root));
  return {
    runtimes,
    close: () => {
      for (const runtime of runtimes) runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};
