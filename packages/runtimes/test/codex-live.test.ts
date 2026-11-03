import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { type HubTools, type PromptRequest, RuntimeError, type RuntimeEvent } from "@hobbots/agents";
import { Effect, Exit, Fiber, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAppServer } from "../src/codex/app-server.ts";
import { LOST_TURN } from "../src/codex/events.ts";
import { type CodexTurnConfig, runCodexTurn } from "../src/codex/turn.ts";

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
 * What the stand-in model does with the next request: say something, call a tool, or hang until the
 * client leaves.
 */
type Move =
  | { readonly say: string }
  | { readonly call: string; readonly input: Record<string, unknown> }
  | { readonly hang: true };

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

const callTool = (response: ServerResponse, name: string, input: Record<string, unknown>, id: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.created", response: { id } });
  const item = { type: "function_call", id: `fc-${id}`, call_id: `call-${id}`, name, arguments: JSON.stringify(input) };
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, { type: "response.completed", response: { id, usage: null } });
  response.end();
};

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
      if ("call" in move) callTool(response, move.call, move.input, `r${served}`);
      else say(response, move.say, `r${served}`);
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

    model.moves.push({ call: "delegate_task", input: { hob: "Quill" } }, { say: "Quill has it." });
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
    model.moves.push({ call: "delegate_task", input: { hob: "Ada" } }, { say: "Not this time." });
    const before = model.requests.length;
    const second = await collect(prompt({ sessionId: thread, prompt: "Again.", hubTools: offering("complete_task") }));
    expect(Exit.isSuccess(second) ? second.value.at(-1) : second).toMatchObject({ _tag: "Completed" });
    expect(toolNames(model.requests[before])).toContain("delegate_task");
    expect(toolNames(model.requests[before])).not.toContain("complete_task");
    expect(calls.at(-1)).toMatchObject({ name: "delegate_task", input: { hob: "Ada" } });
    expect(textOf(model.requests.at(-1))).toContain("delegate_task is not offered in this session.");
  });
});
