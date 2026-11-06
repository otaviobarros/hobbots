import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { type HubTools, type PromptRequest, RuntimeError, type RuntimeEvent, type ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAppServer } from "../src/codex/app-server.ts";
import { LOST_TURN } from "../src/codex/events.ts";
import { type CodexTurnConfig, codexFolders, runCodexTurn } from "../src/codex/turn.ts";
import { ProcessSandbox, type ProcessSandboxShape } from "../src/sandbox.ts";
import { approvalsAnswering, approve } from "./codex-fixture.ts";

/**
 * Runs turns on an installed Codex with a stand-in for the Responses API, as the ADR 024 probe did:
 * the model's moves are fixed, and each request is recorded. Set HOBBOTS_CODEX to the `codex` binary
 * to run it; it needs no account.
 */
const codex = process.env.HOBBOTS_CODEX;

interface ModelRequest {
  readonly input: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
  readonly instructions?: string;
  readonly tools?: ReadonlyArray<{ readonly name?: string; readonly type?: string }>;
}

/**
 * What the stand-in model does with the next request: say something, call a tool (a Responses API
 * output item), or hang until the client leaves.
 */
type Move = { readonly say: string } | { readonly call: Record<string, unknown> } | { readonly hang: true };

const sse = (response: ServerResponse, event: Record<string, unknown>) =>
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);

const say = (response: ServerResponse, text: string, id: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.created", response: { id } });
  const item = { type: "message", role: "assistant", id: `msg-${id}`, content: [{ type: "output_text", text }] };
  sse(response, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
  for (const part of [text.slice(0, 3), text.slice(3)]) {
    sse(response, {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: part,
    });
  }
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 127,
      },
    },
  });
  response.end();
};

const callTool = (response: ServerResponse, item: Record<string, unknown>, id: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.created", response: { id } });
  sse(response, { type: "response.output_item.added", output_index: 0, item });
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    },
  });
  response.end();
};

/** A function tool the stand-in model calls, such as a hub tool or Codex's shell. */
const functionCall = (name: string, input: Record<string, unknown>, callId = `call-${name}`): Move => ({
  call: { type: "function_call", id: `fc-${callId}`, call_id: callId, name, arguments: JSON.stringify(input) },
});

/** A command the stand-in model runs with Codex's shell tool. */
const runs = (callId: string, cmd: string): Move => functionCall("exec_command", { cmd }, callId);

/** A file the stand-in model adds with Codex's patch tool. */
const adds = (callId: string, file: string, line: string): Move => ({
  call: {
    type: "custom_tool_call",
    id: `ct-${callId}`,
    call_id: callId,
    name: "apply_patch",
    input: `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\n`,
  },
});

const standIn = () => {
  const moves: Array<Move> = [];
  const requests: Array<ModelRequest> = [];
  let served = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body) as ModelRequest);
      const move = moves.shift() ?? { say: "Nothing scripted." };
      served += 1;
      if ("hang" in move) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        sse(response, { type: "response.created", response: { id: `r${served}` } });
        return;
      }
      if ("call" in move) {
        callTool(response, move.call, `r${served}`);
        return;
      }
      say(response, move.say, `r${served}`);
    });
  });
  return { server, moves, requests };
};

const textOf = (request: ModelRequest | undefined) => JSON.stringify(request?.input ?? []);

describe.runIf(codex !== undefined)("a turn on an installed Codex", () => {
  const model = standIn();
  const temp = mkdtempSync(join(tmpdir(), "hobbots-codex-live-"));
  let config: CodexTurnConfig;

  beforeAll(async () => {
    await new Promise<void>((resolve) => model.server.listen(0, "127.0.0.1", resolve));
    const { port } = model.server.address() as AddressInfo;
    const spawner = await Effect.runPromise(
      Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(Effect.provide(NodeServices.layer)),
    );
    config = {
      binary: Effect.succeed(codex ?? "codex"),
      start: (command, options) =>
        startAppServer(command, options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: temp,
      interruptGrace: "5 seconds",
      extraArgs: [
        "-c",
        'model_provider="standin"',
        "-c",
        `model_providers.standin={ name = "standin", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`,
        "-c",
        'model="gpt-5.5"',
      ],
    };
  });
  afterAll(() => {
    model.server.close();
    rmSync(temp, { recursive: true, force: true });
  });

  const prompt = (overrides: Partial<PromptRequest> = {}): PromptRequest => ({
    prompt: "Say hello.",
    sessionId: null,
    instructions: "You are Pip, a terse hob.",
    instructionsChanged: false,
    model: null,
    effort: null,
    tools: { runtimeFolder: join(temp, "hob") } as NonNullable<PromptRequest["tools"]>,
    ...overrides,
  });

  const collect = (request: PromptRequest) =>
    Effect.runPromise(Stream.runCollect(runCodexTurn(config, request)).pipe(Effect.exit));

  let session = "";

  // covers RT-001, AG-005
  it("[TC-RT-029] answers, then resumes its thread in a new process with changed instructions", {
    timeout: 60_000,
  }, async () => {
    model.moves.push({ say: "Hello there." });
    const first = await collect(prompt());
    expect(Exit.isSuccess(first)).toBe(true);
    const events = Exit.isSuccess(first) ? first.value : [];
    const started = events.find((event) => event._tag === "SessionStarted");
    session = started?._tag === "SessionStarted" ? started.sessionId : "";
    expect(session).not.toBe("");
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello there.");
    // The hob's instructions and the no-attribution rule reached the model, and the tools that skip
    // approval did not.
    const [request] = model.requests;
    expect(textOf(request)).toContain("You are Pip, a terse hob.");
    expect(textOf(request)).toContain("Never add Codex attribution");
    const offered = (request?.tools ?? []).map((tool) => tool.name ?? tool.type);
    for (const closed of ["view_image", "web_search", "spawn_agent"]) expect(offered).not.toContain(closed);
    expect(events.at(-1)).toMatchObject({
      _tag: "Completed",
      sessionId: session,
      text: "Hello there.",
      usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 7 },
    });

    model.moves.push({ say: "Again." });
    const second = await collect(
      prompt({
        sessionId: session,
        prompt: "Once more.",
        instructions: "You are Pip, now loud.",
        instructionsChanged: true,
      }),
    );
    expect(Exit.isSuccess(second) ? second.value.at(-1) : second).toMatchObject({
      _tag: "Completed",
      sessionId: session,
      text: "Again.",
    });
    // The resumed thread sent the earlier turn, and the new instructions inside this one.
    const resumed = textOf(model.requests.at(-1));
    expect(resumed).toContain("Say hello.");
    expect(resumed).toContain("Hello there.");
    expect(resumed).toContain("You are Pip, now loud.");
  });

  // covers RT-001, EX-004
  it("[TC-RT-030] stops mid-turn once Codex acknowledges the interrupt, and the thread goes on", {
    timeout: 60_000,
  }, async () => {
    model.moves.push({ hang: true });
    const seen: Array<RuntimeEvent> = [];
    const asked = model.requests.length;
    const stopped = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* runCodexTurn(config, prompt({ sessionId: session, prompt: "Think hard." })).pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.forkChild,
        );
        yield* Effect.sleep("100 millis").pipe(Effect.repeat({ until: () => model.requests.length > asked }));
        const before = Date.now();
        yield* Fiber.interrupt(fiber);
        return Date.now() - before;
      }),
    );
    expect(seen.map((event) => event._tag)).toEqual(["SessionStarted"]);
    // Acknowledged well inside the grace period, not cut off by it.
    expect(stopped).toBeLessThan(5_000);

    model.moves.push({ say: "Back." });
    const after = await collect(prompt({ sessionId: session, prompt: "Still there?" }));
    expect(Exit.isSuccess(after) ? after.value.at(-1) : after).toMatchObject({ _tag: "Completed", text: "Back." });
  });

  // covers RT-001, EX-004
  it("[TC-RT-031] ends a turn whose Codex was killed as uncertain", { timeout: 60_000 }, async () => {
    // Codex runs through a script that leaves its process ID behind, so the test can kill it.
    const pidFile = join(temp, "codex.pid");
    const wrapper = join(temp, "codex-wrapper");
    writeFileSync(wrapper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${codex}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    model.moves.push({ hang: true });
    const asked = model.requests.length;
    const kill = Effect.sleep("100 millis").pipe(
      Effect.repeat({ until: () => model.requests.length > asked && existsSync(pidFile) }),
      Effect.andThen(Effect.sync(() => process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"))),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkChild(kill);
        return yield* Stream.runCollect(
          runCodexTurn(
            { ...config, binary: Effect.succeed(wrapper) },
            prompt({ sessionId: session, prompt: "Again?" }),
          ),
        ).pipe(Effect.exit);
      }),
    );
    expect(exit).toEqual(Exit.fail(new RuntimeError({ message: LOST_TURN })));
  });
  // covers OR-001, PE-003, EX-004
  it("[TC-RT-083] serves hub tools as dynamic tools, and a resumed thread keeps the ones it started with", {
    timeout: 60_000,
  }, async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown; readonly step: string | undefined }> = [];
    const offering = (name: string): HubTools => ({
      tools: [
        {
          name,
          description: `The hub's ${name}.`,
          inputSchema: { type: "object", properties: { hob: { type: "string" } } },
          label: "Delegating a Task",
        },
      ],
      call: (called, input, step) =>
        Effect.sync(() => {
          calls.push({ name: called, input, step: step?.id });
          return called === name
            ? { text: "Delegated to Quill.", refused: false }
            : { text: `${called} is not offered in this session.`, refused: true };
        }),
    });
    const toolNames = (request: ModelRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name);

    model.moves.push(functionCall("delegate_task", { hob: "Quill" }, "call-quill"), { say: "Quill has it." });
    const asked = model.requests.length;
    const first = await collect(prompt({ sessionId: null, hubTools: offering("delegate_task") }));
    expect(Exit.isSuccess(first) ? first.value.at(-1) : first).toMatchObject({
      _tag: "Completed",
      text: "Quill has it.",
    });
    expect(toolNames(model.requests[asked])).toContain("delegate_task");
    const [call] = calls;
    expect(call).toMatchObject({ name: "delegate_task", input: { hob: "Quill" } });
    expect(call?.step).toBeDefined();
    // The hub's answer reached the model, and the call showed as a step that ended with it.
    expect(textOf(model.requests.at(-1))).toContain("Delegated to Quill.");
    const events = Exit.isSuccess(first) ? first.value : [];
    expect(events).toContainEqual({ _tag: "StepStarted", id: call?.step, kind: "tool", label: "Delegating a Task" });
    expect(events).toContainEqual({ _tag: "ToolFinished", id: call?.step, failed: false });
    const started = events.find((event) => event._tag === "SessionStarted");
    const thread = started?._tag === "SessionStarted" ? started.sessionId : "";

    // Resumed with other hub tools, the thread still offers its first ones, and this turn's hub
    // refuses a call to one it does not offer.
    model.moves.push(functionCall("delegate_task", { hob: "Ada" }, "call-ada"), { say: "Not this time." });
    const before = model.requests.length;
    const second = await collect(prompt({ sessionId: thread, prompt: "Again.", hubTools: offering("complete_task") }));
    expect(Exit.isSuccess(second) ? second.value.at(-1) : second).toMatchObject({ _tag: "Completed" });
    expect(toolNames(model.requests[before])).toContain("delegate_task");
    expect(toolNames(model.requests[before])).not.toContain("complete_task");
    expect(calls.at(-1)).toMatchObject({ name: "delegate_task", input: { hob: "Ada" } });
    expect(textOf(model.requests.at(-1))).toContain("delegate_task is not offered in this session.");
  });
});

/** Runs one turn with tools, allowing every call the policy asks about, with what was asked and recorded. */
const policyTurn = async (config: CodexTurnConfig, access: ToolAccess, prompt: string, sessionId: string | null) => {
  const { asked, approvals } = approvalsAnswering(approve, access);
  const recorded: Array<RuntimeEvent> = [];
  const exit = await Effect.runPromise(
    Stream.runCollect(
      runCodexTurn(config, {
        prompt,
        sessionId,
        instructions: "You are Pip.",
        instructionsChanged: false,
        model: null,
        effort: null,
        tools: access,
        approvals,
        recordToolStart: (event) => Effect.sync(() => recorded.push(event) > 0),
      }),
    ).pipe(Effect.exit),
  );
  expect(Exit.isSuccess(exit), String(exit)).toBe(true);
  return { asked, recorded, events: Exit.isSuccess(exit) ? exit.value : [] };
};

/** A hob whose every command asks, with its file changes allowed. */
const askingHob = (root: string): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [join(root, "project")],
    hob: { ...EMPTY_HOB_POLICY, overrides: { "run-commands": "ask" } },
    dataFolder: join(root, "data"),
    restrictions: [],
  },
  folders: [join(root, "project")],
  runtimeFolder: join(root, "runtimes", "hob-1"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

/**
 * The sandbox, with Codex sent through its proxy to a stand-in on a private address. sandbox-runtime
 * lets clients reach private ranges directly (NO_PROXY), which the sandbox then refuses on macOS, so
 * the stand-in, which this machine's private address serves, is reached only through the proxy.
 * Codex's real model hosts are public, so a hob's turn never needs this.
 */
const throughProxy = (sandbox: ProcessSandboxShape): ProcessSandboxShape => ({
  ...sandbox,
  prepare: (scope) =>
    Effect.map(sandbox.prepare(scope), (prepared) => ({
      ...prepared,
      spawnArgs: (command, args, env) =>
        prepared.spawnArgs("/usr/bin/env", ["-u", "NO_PROXY", "-u", "no_proxy", command, ...args], env),
    })),
});

/**
 * A turn on an installed Codex inside Hobbots' sandbox, under the hob's policy (ADR 014, ADR 024).
 * Needs HOBBOTS_CODEX and the sandbox: on Linux, HOBBOTS_SANDBOX_TESTS=1 with bubblewrap, socat and
 * a checkout outside the home folder, whose sandbox-runtime helper the sandbox can read. The
 * stand-in model listens on this machine's first outside address, which the sandbox's proxy serves.
 */
const sandboxed = codex !== undefined && (process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1");
const outsideAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address !== undefined && address.family === "IPv4" && !address.internal)?.address;

describe.runIf(sandboxed && outsideAddress !== undefined)("a turn on an installed Codex in Hobbots' sandbox", () => {
  const model = standIn();
  // Codex sets up its helper programs only in a home outside the temporary folder.
  const root = realpathSync(mkdtempSync(join(homedir(), ".hobbots-codex-sandbox-")));
  const project = join(root, "project");
  const runtimeFolder = join(root, "runtimes", "hob-1");
  mkdirSync(project);
  const runtime = ManagedRuntime.make(Layer.mergeAll(ProcessSandbox.layer, PolicyEngine.node, NodeServices.layer));
  let config: CodexTurnConfig;
  afterAll(async () => {
    model.server.close();
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const access = askingHob(root);

  beforeAll(async () => {
    await new Promise<void>((resolve) => model.server.listen(0, "0.0.0.0", resolve));
    const { port } = model.server.address() as AddressInfo;
    const { engine, sandbox, spawner } = await runtime.runPromise(
      Effect.all({
        engine: Effect.service(PolicyEngine),
        sandbox: Effect.service(ProcessSandbox),
        spawner: Effect.service(ChildProcessSpawner.ChildProcessSpawner),
      }),
    );
    expect(sandbox.state, sandbox.evidence).toBe("on");
    config = {
      binary: Effect.succeed(codex ?? "codex"),
      start: (command, options) =>
        startAppServer(command, options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: join(root, "workspace"),
      interruptGrace: "5 seconds",
      policy: { engine, sandboxState: "on", sandbox: throughProxy(sandbox) },
      extraArgs: [
        "-c",
        'model_provider="standin"',
        "-c",
        `model_providers.standin={ name = "standin", base_url = "http://${outsideAddress}:${port}/v1", wire_api = "responses" }`,
        "-c",
        'model="gpt-5.5"',
      ],
    };
  });

  const turn = (prompt: string, sessionId: string | null) => policyTurn(config, access, prompt, sessionId);

  // covers PE-003, EX-004, PE-005, ADR 023, ADR 024
  it("[TC-RT-068] holds a command for approval, runs it after Allow in the sandbox, and a rule it writes never skips the policy", {
    timeout: 120_000,
  }, async () => {
    const { home } = codexFolders(runtimeFolder);
    const rule = `prefix_rule(pattern=["touch"], decision="allow")`;
    model.moves.push(
      runs(
        "c1",
        [
          `printf '%s\\n' '${rule}' > '${join(home, "rules", "allow.rules")}'; echo home-rules=$?`,
          `echo x >> '${join(home, "config.toml")}'; echo home-config=$?`,
          `mkdir -p .codex/rules && printf '%s\\n' '${rule}' > .codex/rules/allow.rules; echo folder-rules=$?`,
          `cat ~/.ssh/config >/dev/null 2>&1; echo home-folder=$?`,
        ].join("; "),
      ),
      adds("p1", "notes.txt", "hello"),
      { say: "Done." },
    );
    const first = await turn("Set things up.", null);
    // The command waited for the user, was recorded once allowed, and reported its output.
    expect(first.asked).toEqual([expect.objectContaining({ stepId: "c1", tool: "Bash" })]);
    expect(first.recorded.map((event) => event._tag === "ToolStarted" && [event.id, event.tool])).toEqual([
      ["c1", "Bash"],
      ["p1", "apply_patch"],
    ]);
    expect(first.recorded[0]).toMatchObject({ command: { sandboxed: true, liveOutput: true } });
    const tags = first.events.map((event) => ("id" in event ? `${event._tag}:${event.id}` : event._tag));
    expect(tags).toContain("ToolAwaitingApproval:c1");
    expect(tags.indexOf("ToolAwaitingApproval:c1")).toBeLessThan(tags.indexOf("ToolFinished:c1"));
    // A short command may end before Codex streams any of it; its end then carries the whole output.
    const streamed = first.events
      .filter((event) => event._tag === "ToolOutput" && event.id === "c1")
      .map((event) => (event._tag === "ToolOutput" ? event.text : ""))
      .join("");
    const finished = first.events.find((event) => event._tag === "ToolFinished" && event.id === "c1");
    const output = streamed || (finished?._tag === "ToolFinished" ? (finished.output ?? "") : "");
    // Codex's home stays closed to its commands but for what it must write; the hob's folder is open.
    expect(output).toMatch(/home-rules=[1-9]/);
    expect(output).toMatch(/home-config=[1-9]/);
    expect(output).toContain("folder-rules=0");
    expect(output).toMatch(/home-folder=[1-9]/);
    expect(existsSync(join(home, "rules", "allow.rules"))).toBe(false);
    expect(readFileSync(join(project, "notes.txt"), "utf8")).toBe("hello\n");
    expect(first.events.at(-1)).toMatchObject({ _tag: "Completed", text: "Done." });
    // The first request offered Codex's shell and patch tools, and none that skip the hub.
    const offered = (model.requests[0]?.tools ?? []).map((tool) => tool.name ?? tool.type);
    expect(offered).toEqual(expect.arrayContaining(["exec_command", "apply_patch"]));
    for (const closed of ["view_image", "web_search", "image_generation", "spawn_agent"]) {
      expect(offered).not.toContain(closed);
    }
    const session = first.events.find((event) => event._tag === "SessionStarted");

    // A later turn: the rule in the folder is not loaded, so the command it names still asks.
    model.moves.push(runs("c2", "touch b.txt"), { say: "Touched." });
    const second = await turn("Touch it.", session?._tag === "SessionStarted" ? session.sessionId : null);
    expect(second.asked).toEqual([expect.objectContaining({ stepId: "c2", arguments: { command: "touch b.txt" } })]);
    expect(existsSync(join(project, "b.txt"))).toBe(true);
  });
});

describe.runIf(codex !== undefined)("a turn on an installed Codex under the hob's policy", () => {
  const model = standIn();
  const root = realpathSync(mkdtempSync(join(homedir(), ".hobbots-codex-policy-")));
  mkdirSync(join(root, "project"));
  const access = askingHob(root);
  let config: CodexTurnConfig;
  beforeAll(async () => {
    await new Promise<void>((resolve) => model.server.listen(0, "127.0.0.1", resolve));
    const { port } = model.server.address() as AddressInfo;
    const { engine, spawner } = await Effect.runPromise(
      Effect.all({
        engine: Effect.service(PolicyEngine),
        spawner: Effect.service(ChildProcessSpawner.ChildProcessSpawner),
      }).pipe(Effect.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer))),
    );
    config = {
      binary: Effect.succeed(codex ?? "codex"),
      start: (command, options) =>
        startAppServer(command, options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      signIn: () => Effect.succeed(null),
      clientVersion: "0.0.0",
      workspaceDir: join(root, "workspace"),
      // Decided as if sandboxed, but Codex runs without the sandbox: this checks the policy alone.
      policy: {
        engine,
        sandboxState: "on",
        sandbox: { state: "unavailable", evidence: "not started for this check", prepare: () => Effect.never },
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
  });
  afterAll(() => {
    model.server.close();
    rmSync(root, { recursive: true, force: true });
  });

  // covers PE-003, EX-004, ADR 023, ADR 024
  it("[TC-RT-069] holds a command for approval, runs it after Allow, streams it to the Workbench, and records a patch", {
    timeout: 60_000,
  }, async () => {
    model.moves.push(runs("c1", "printf ran; printf ' twice'"), adds("p1", "notes.txt", "hello"), { say: "Done." });
    const { asked, recorded, events } = await policyTurn(config, access, "Run it.", null);
    expect(asked).toEqual([
      expect.objectContaining({ stepId: "c1", tool: "Bash", arguments: { command: "printf ran; printf ' twice'" } }),
    ]);
    expect(recorded).toEqual([
      expect.objectContaining({ id: "c1", tool: "Bash", command: expect.objectContaining({ liveOutput: true }) }),
      expect.objectContaining({ id: "p1", tool: "apply_patch", label: "Editing notes.txt" }),
    ]);
    const tags = events.map((event) => ("id" in event ? `${event._tag}:${event.id}` : event._tag));
    expect(tags.filter((tag) => tag.endsWith(":c1") || tag.endsWith(":p1"))).toEqual(
      expect.arrayContaining(["ToolAwaitingApproval:c1", "ToolFinished:c1", "ToolFinished:p1"]),
    );
    expect(events.find((event) => event._tag === "ToolFinished" && event.id === "c1")).toMatchObject({
      failed: false,
      output: "ran twice",
      exitCode: 0,
    });
    expect(readFileSync(join(root, "project", "notes.txt"), "utf8")).toBe("hello\n");
    expect(events.at(-1)).toMatchObject({ _tag: "Completed", text: "Done." });
  });

  // regression for #1048
  it("[TC-RT-1048-03] waits for a command that outlives Codex's turn, records how it really ended and tells the hob", {
    timeout: 60_000,
  }, async () => {
    // Codex answers the call once its wait ends while the command goes on, and the model replies.
    model.moves.push(
      functionCall("exec_command", { cmd: "sleep 3; echo slept; exit 3", yield_time_ms: 500 }, "c-long"),
      { say: "Done." },
      { say: "It failed with exit code 3." },
    );
    const before = model.requests.length;
    const { asked, events } = await policyTurn(config, access, "Run the slow one.", null);
    expect(asked).toEqual([expect.objectContaining({ stepId: "c-long", tool: "Bash" })]);
    // Codex's own answer to the call says the command still runs.
    expect(textOf(model.requests[before + 1])).toContain("Process running with session ID");
    // Hobbots kept the App Server until the command ended, so its end carries the real exit code.
    expect(events.find((event) => event._tag === "ToolFinished" && event.id === "c-long")).toMatchObject({
      failed: true,
      exitCode: 3,
      output: expect.stringContaining("slept"),
    });
    // The hob was told in a follow-up turn, and the reply holds what both turns said.
    const followUp = textOf(model.requests[before + 2]);
    expect(followUp).toContain("<commands-ended>");
    expect(followUp).toContain("sleep 3; echo slept; exit 3");
    expect(followUp).toContain("exited with code 3");
    expect(events.at(-1)).toMatchObject({ _tag: "Completed", text: "Done.\n\nIt failed with exit code 3." });
  });
});
