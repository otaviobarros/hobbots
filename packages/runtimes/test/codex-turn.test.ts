import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HubTools,
  type PromptRequest,
  RuntimeError,
  type RuntimeEvent,
  RuntimeLimitReached,
} from "@hobbots/agents";
import { ApprovalId, EMPTY_HOB_POLICY } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Exit, Fiber, PubSub, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { SANDBOX_NOTE } from "../src/claude-code.ts";
import type { AppServer, AppServerCommand, AppServerNotification } from "../src/codex/app-server.ts";
import type { ChatGptTokens } from "../src/codex/auth.ts";
import { codexTurnEvents, LOST_CALL, LOST_TURN } from "../src/codex/events.ts";
import { notOffered } from "../src/codex/hub-tools.ts";
import {
  CODEX_MODEL_HOSTS,
  type CodexTurnConfig,
  codexFolders,
  codexWrites,
  NO_ATTRIBUTION_NOTE,
  runCodexTurn,
  type StartAppServer,
  sandboxedCommand,
  TOOLS_CLOSED,
} from "../src/codex/turn.ts";
import { NO_GIT_IDENTITY_NOTE } from "../src/git-config.ts";
import { ProcessSandbox, type ProcessSandboxShape, type SandboxScope, sandboxFilesystem } from "../src/sandbox.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-codex-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const THREAD = "thr-1";
const TURN = "turn-1";

const n = (method: string, params: Record<string, unknown>) =>
  ({ method, params: { threadId: THREAD, turnId: TURN, ...params } }) as AppServerNotification;
const delta = (itemId: string, text: string) => n("item/agentMessage/delta", { itemId, delta: text });
const item = (kind: "item/started" | "item/completed", body: Record<string, unknown>) => n(kind, { item: body });
const message = (id: string, text: string) => item("item/completed", { type: "agentMessage", id, text });
const usage = (last: number, total: number) => {
  const breakdown = (tokens: number) => ({
    totalTokens: tokens * 4,
    inputTokens: tokens * 2,
    cachedInputTokens: tokens,
    cacheWriteInputTokens: 0,
    outputTokens: tokens,
    reasoningOutputTokens: 0,
  });
  return n("thread/tokenUsage/updated", {
    tokenUsage: { last: breakdown(last), total: breakdown(total), modelContextWindow: 200_000 },
  });
};
const completed = (status: string, error: unknown = null) =>
  n("turn/completed", { turn: { id: TURN, items: [], status, error } });

/**
 * A scripted App Server: answers the client's requests, and once a turn starts asks `asks` and sends
 * `script`'s notifications. `turn/interrupt` ends the turn as interrupted, as Codex does.
 */
const fakeServer = (options: {
  readonly script?: ReadonlyArray<AppServerNotification>;
  readonly asks?: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  /** Ends the process after the script, before any `turn/completed`. */
  readonly dies?: boolean;
  /** Never answers `turn/interrupt`, as a Codex that stopped answering. */
  readonly deaf?: boolean;
}) => {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const answers: Array<unknown> = [];
  const commands: Array<AppServerCommand> = [];
  let closed = 0;
  const start: StartAppServer = (command, { handlers }) =>
    Effect.gen(function* () {
      commands.push(command);
      const notes = yield* PubSub.unbounded<AppServerNotification | null>();
      yield* Effect.addFinalizer(() => Effect.sync(() => (closed += 1)));
      const ask = (method: string, params: unknown) => {
        const handler = handlers?.[method];
        return handler === undefined
          ? Effect.succeed({ refused: "no handler" })
          : handler(params, method).pipe(Effect.catch((error) => Effect.succeed({ refused: error.message })));
      };
      const run = Effect.gen(function* () {
        for (const { method, params } of options.asks ?? []) answers.push(yield* ask(method, params));
        for (const note of options.script ?? []) yield* PubSub.publish(notes, note);
        if (options.dies) yield* PubSub.publish(notes, null);
      });
      const requestUnknown = (method: string, params: unknown) =>
        Effect.gen(function* () {
          requests.push({ method, params });
          switch (method) {
            case "thread/start":
            case "thread/resume":
              return { thread: { id: THREAD }, model: "m" };
            case "turn/start":
              yield* Effect.forkDetach(run);
              return { turn: { id: TURN, status: "inProgress", error: null } };
            case "turn/interrupt":
              if (options.deaf) return yield* Effect.never;
              yield* PubSub.publish(notes, completed("interrupted"));
              return {};
            default:
              return {};
          }
        });
      return {
        initialized: {
          userAgent: "codex",
          codexHome: command.env.CODEX_HOME ?? "",
          platformFamily: "unix",
          platformOs: "linux",
        },
        request: requestUnknown as AppServer["request"],
        requestUnknown,
        subscribe: PubSub.subscribe(notes).pipe(
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(Stream.takeWhile((note) => note !== null)),
          ),
        ) as AppServer["subscribe"],
        exited: Effect.never,
      } satisfies AppServer;
    });
  return { start, requests, answers, commands, closed: () => closed };
};

const config = (
  start: StartAppServer,
  signIn: Effect.Effect<ChatGptTokens | null, RuntimeError> = Effect.succeed(null),
): CodexTurnConfig => ({
  binary: Effect.succeed("/bin/codex"),
  start,
  signIn: () => signIn,
  clientVersion: "0.0.0",
  workspaceDir: mkdtempSync(join(temp, "w-")),
});

const prompt = (overrides: Partial<PromptRequest> = {}): PromptRequest => ({
  prompt: "Hello",
  sessionId: null,
  instructions: "Be brief.",
  instructionsChanged: false,
  model: null,
  effort: null,
  ...overrides,
});

const run = (turnConfig: CodexTurnConfig, request: PromptRequest = prompt()) =>
  Effect.runPromise(Stream.runCollect(runCodexTurn(turnConfig, request)).pipe(Effect.exit));

const events = (exit: Exit.Exit<ReadonlyArray<RuntimeEvent>, unknown>) => (Exit.isSuccess(exit) ? exit.value : []);

describe("a Codex turn", () => {
  // covers RT-001, AG-005
  it("[TC-RT-020] streams the reply, completes with its text and this turn's token usage only", async () => {
    const server = fakeServer({
      script: [
        n("turn/started", { turn: { id: TURN } }),
        item("item/started", { type: "agentMessage", id: "m1", text: "" }),
        delta("m1", "Hel"),
        delta("m1", "lo"),
        message("m1", "Hello"),
        // The thread had 100 tokens of each before this turn's first request of 10.
        usage(10, 110),
        delta("m2", "Done"),
        message("m2", "Done."),
        usage(5, 115),
        completed("completed"),
      ],
    });
    const exit = await run(config(server.start));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events(exit)).toEqual([
      { _tag: "SessionStarted", sessionId: THREAD, billing: null },
      { _tag: "TextDelta", text: "Hel" },
      { _tag: "TextDelta", text: "lo" },
      { _tag: "TextDelta", text: "\n\n" },
      { _tag: "TextDelta", text: "Done" },
      { _tag: "TextDelta", text: "." },
      {
        _tag: "Completed",
        sessionId: THREAD,
        text: "Hello\n\nDone.",
        // Input counts what the cache neither read nor wrote: 30 input less 15 cached.
        usage: {
          timeToRequestMs: null,
          timeToFirstStreamMs: null,
          timeToFirstTokenMs: null,
          inputTokens: 15,
          outputTokens: 15,
          cacheReadTokens: 15,
          cacheWriteTokens: 0,
        },
      },
    ]);
    expect(server.closed()).toBe(1);
  });

  // covers RT-001, ADR 024
  it("[TC-RT-021] starts a Codex thread that asks about every call, inside Hobbots' sandbox, with no Codex attribution", async () => {
    const server = fakeServer({ script: [completed("completed")] });
    const turnConfig = config(server.start);
    await run(turnConfig, prompt({ model: "gpt-5.5-codex", effort: "high" }));
    const [start, turn] = server.requests;
    expect(start).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "untrusted",
        sandbox: "danger-full-access",
        developerInstructions: `Be brief.\n\n${NO_ATTRIBUTION_NOTE}`,
        model: "gpt-5.5-codex",
        dynamicTools: [],
      },
    });
    expect(turn).toMatchObject({
      method: "turn/start",
      params: {
        threadId: THREAD,
        input: [{ type: "text", text: "Hello" }],
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
        model: "gpt-5.5-codex",
        effort: "high",
      },
    });
    // The process gets named variables and its own home, never the hub's whole environment.
    const [command] = server.commands;
    expect(command?.args).toEqual(["app-server"]);
    expect(command?.env.CODEX_HOME).toBe(codexFolders(join(turnConfig.workspaceDir, "codex-chat")).home);
    expect(Object.keys(command?.env ?? {}).every((key) => !/TOKEN|SECRET|KEY/.test(key))).toBe(true);
  });

  // covers ADR 028
  it("[TC-RT-506] starts an ephemeral turn's Codex thread without saving it, and a hob's as it was", async () => {
    const server = fakeServer({ script: [completed("completed")] });
    await run(config(server.start), prompt({ ephemeral: true, model: "gpt-mini" }));
    await run(config(server.start), prompt());
    const starts = server.requests.filter((request) => request.method === "thread/start");
    expect(starts[0]?.params).toMatchObject({ ephemeral: true, model: "gpt-mini", dynamicTools: [] });
    expect(starts[1]?.params).not.toHaveProperty("ephemeral");
  });

  // covers RT-001, CH-004, ADR 017
  it("[TC-RT-022] resumes the thread's Codex session, with changed instructions and a briefing inside the turn", async () => {
    const server = fakeServer({ script: [completed("completed")] });
    await run(
      config(server.start),
      prompt({ sessionId: THREAD, instructionsChanged: true, briefing: "<briefing>Claude replied.</briefing>" }),
    );
    const [resume, turn] = server.requests;
    expect(resume).toMatchObject({
      method: "thread/resume",
      params: { threadId: THREAD, approvalPolicy: "untrusted" },
    });
    expect(resume?.params).not.toHaveProperty("developerInstructions");
    const text = (turn?.params as { input: ReadonlyArray<{ text: string }> } | undefined)?.input[0]?.text ?? "";
    expect(text).toContain(`<current-instructions>`);
    expect(text).toContain(`Be brief.\n\n${NO_ATTRIBUTION_NOTE}`);
    expect(text.indexOf("<briefing>")).toBeGreaterThan(text.indexOf("</current-instructions>"));
    expect(text.endsWith("Hello")).toBe(true);
  });

  // covers RT-001, EX-004
  it("[TC-RT-023] cancels by interrupting the turn and ends only once Codex acknowledges it", async () => {
    const server = fakeServer({ script: [delta("m1", "Working")] });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const seen: Array<RuntimeEvent> = [];
        const fiber = yield* runCodexTurn(config(server.start), prompt()).pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.forkChild,
        );
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => seen.length >= 2 }));
        yield* Fiber.interrupt(fiber);
        return seen;
      }),
    );
    expect(exit.map((event) => event._tag)).toEqual(["SessionStarted", "TextDelta"]);
    expect(server.requests.map((request) => request.method)).toContain("turn/interrupt");
    expect(server.requests.find((request) => request.method === "turn/interrupt")?.params).toEqual({
      threadId: THREAD,
      turnId: TURN,
    });
    expect(server.closed()).toBe(1);
  });

  // covers RT-001, EX-004
  it("[TC-RT-033] ends the process after the grace period when Codex never answers the interrupt", async () => {
    const server = fakeServer({ script: [delta("m1", "Working")], deaf: true });
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const events: Array<RuntimeEvent> = [];
        const fiber = yield* runCodexTurn({ ...config(server.start), interruptGrace: "50 millis" }, prompt()).pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => events.length >= 2 }));
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
        return events;
      }),
    );
    expect(seen.map((event) => event._tag)).toEqual(["SessionStarted", "TextDelta"]);
    expect(server.requests.map((request) => request.method)).toContain("turn/interrupt");
    expect(server.closed()).toBe(1);
  });

  // covers RT-001, EX-004
  it("[TC-RT-024] ends a turn whose App Server exited first as uncertain, never as done", async () => {
    const server = fakeServer({ script: [delta("m1", "Half")], dies: true });
    const exit = await run(config(server.start));
    expect(exit).toEqual(Exit.fail(new RuntimeError({ message: LOST_TURN })));
  });

  // covers PE-005, ADR 024
  it("[TC-RT-025] refuses every tool call on a turn without tools, and the turn goes on", async () => {
    const ask = (method: string, params: Record<string, unknown>) => ({
      method,
      params: { threadId: THREAD, turnId: TURN, ...params },
    });
    const server = fakeServer({
      asks: [
        ask("item/commandExecution/requestApproval", { itemId: "c1", command: "ls -la", cwd: "/w" }),
        ask("item/fileChange/requestApproval", { itemId: "f1" }),
        ask("mcpServer/elicitation/request", { serverName: "s", mode: "form" }),
        ask("item/permissions/requestApproval", { itemId: "p1" }),
      ],
      script: [message("m1", "I could not run it."), completed("completed")],
    });
    const exit = await run(config(server.start));
    expect(server.answers.slice(0, 3)).toEqual([
      { decision: "decline" },
      { decision: "decline" },
      { action: "decline", content: null, _meta: null },
    ]);
    // Anything else Codex asks the client fails, which Codex takes as refused.
    expect(server.answers[3]).toEqual({ refused: "no handler" });
    const denied = events(exit).filter((event) => event._tag === "ToolDenied");
    expect(denied).toEqual([
      expect.objectContaining({
        id: "c1",
        tool: "Bash",
        operation: "run-commands",
        label: "Running ls -la",
        targets: ["/w"],
      }),
      expect.objectContaining({
        id: "f1",
        tool: "apply_patch",
        operation: "edit-files",
        reason: TOOLS_CLOSED,
        decidedBy: "policy",
      }),
    ]);
    expect(events(exit).at(-1)).toMatchObject({ _tag: "Completed", text: "I could not run it." });
  });

  // covers RT-001
  it("[TC-RT-026] fails a turn Codex failed, and reports a reached usage limit as its own error", async () => {
    const failed = await run(
      config(
        fakeServer({
          script: [completed("failed", { message: "Model overloaded.", codexErrorInfo: "serverOverloaded" })],
        }).start,
      ),
    );
    expect(failed).toEqual(Exit.fail(new RuntimeError({ message: "Model overloaded." })));
    const limited = await run(
      config(
        fakeServer({
          script: [completed("failed", { message: "Limit.", codexErrorInfo: "usageLimitExceeded" })],
        }).start,
      ),
    );
    expect(limited).toEqual(Exit.fail(new RuntimeLimitReached({ resetsAt: null })));
  });

  // covers RT-001, ADR 024
  it("[TC-RT-027] signs the turn in through the protocol and answers Codex's refresh with a fresh token", async () => {
    let issued = 0;
    const signIn = Effect.sync(
      (): ChatGptTokens => ({ accessToken: `token-${++issued}`, chatgptAccountId: "ws-1", chatgptPlanType: "plus" }),
    );
    const server = fakeServer({
      asks: [{ method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized" } }],
      script: [completed("completed")],
    });
    const exit = await run(config(server.start, signIn));
    expect(server.requests[0]).toEqual({
      method: "account/login/start",
      params: { type: "chatgptAuthTokens", accessToken: "token-1", chatgptAccountId: "ws-1", chatgptPlanType: "plus" },
    });
    expect(server.answers[0]).toEqual({ accessToken: "token-2", chatgptAccountId: "ws-1", chatgptPlanType: "plus" });
    expect(events(exit)[0]).toEqual({ _tag: "SessionStarted", sessionId: THREAD, billing: "subscription (plus)" });
    // The token travels in the protocol only.
    expect(JSON.stringify(server.commands[0]?.env)).not.toContain("token-");
  });

  // covers ADR 024
  it("[TC-RT-028] writes the hob's Codex settings: no image viewer, no sub-agents, no web search", async () => {
    const server = fakeServer({ script: [completed("completed")] });
    const runtimeFolder = mkdtempSync(join(temp, "hob-"));
    await run(config(server.start), prompt({ tools: { runtimeFolder } as NonNullable<PromptRequest["tools"]> }));
    const { home, state } = codexFolders(runtimeFolder);
    expect(server.commands[0]?.env.CODEX_HOME).toBe(home);
    const settings = readFileSync(join(home, "config.toml"), "utf8");
    expect(settings).toContain(`sqlite_home = ${JSON.stringify(state)}`);
    expect(settings).toContain('web_search = "disabled"');
    expect(settings).toMatch(/\[features\][^[]*view_image = false[^[]*multi_agent = false/);
  });

  // Hub tools (#440): served as Codex dynamic tools on the App Server's channel (ADR 024).
  const hubCalls: Array<{ readonly name: string; readonly input: unknown; readonly step?: string }> = [];
  const hub: HubTools = {
    tools: [
      {
        name: "delegate_task",
        description: "Hands a Task to another hob.",
        inputSchema: { type: "object", properties: { hob: { type: "string" } }, required: ["hob"] },
        label: "Delegating a Task",
      },
    ],
    call: (name, input, step) =>
      Effect.sync(() => {
        hubCalls.push({ name, input, ...(step ? { step: step.id } : {}) });
        step?.report({
          _tag: "ToolAwaitingApproval",
          id: step.id,
          tool: name,
          operation: "run-commands",
          targets: [],
          label: "Delegating a Task",
          approvalId: ApprovalId.make("a1"),
        });
        return name === "delegate_task"
          ? { text: "Delegated to Quill as Task t-1.", refused: false }
          : { text: `${name} is not offered.`, refused: true };
      }),
  };
  const toolCall = (callId: string, tool: string, input: unknown = {}) => ({
    method: "item/tool/call",
    params: { threadId: THREAD, turnId: TURN, callId, namespace: null, tool, arguments: input },
  });
  const toolDone = (id: string, tool: string, success: boolean) =>
    item("item/completed", { type: "dynamicToolCall", id, tool, status: success ? "completed" : "failed", success });

  // covers OR-001, PE-003, ADR 024
  it("[TC-RT-080] declares the turn's hub tools on a new Codex thread and answers each call through the hub, as a step", async () => {
    hubCalls.length = 0;
    const server = fakeServer({
      asks: [toolCall("call_1", "delegate_task", { hob: "Quill" })],
      script: [toolDone("call_1", "delegate_task", true), message("m1", "Quill has it."), completed("completed")],
    });
    const exit = await run(config(server.start), prompt({ hubTools: hub }));
    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      dynamicTools: [
        {
          type: "function",
          name: "delegate_task",
          description: "Hands a Task to another hob.",
          inputSchema: hub.tools[0]?.inputSchema,
        },
      ],
    });
    // The hub decided the call with its step, so an approval it asks for waits on that step.
    expect(hubCalls).toEqual([{ name: "delegate_task", input: { hob: "Quill" }, step: "call_1" }]);
    expect(server.answers[0]).toEqual({
      contentItems: [{ type: "inputText", text: "Delegated to Quill as Task t-1." }],
      success: true,
    });
    expect(events(exit).filter((event) => event._tag !== "TextDelta")).toEqual([
      { _tag: "SessionStarted", sessionId: THREAD, billing: null },
      { _tag: "StepStarted", id: "call_1", kind: "tool", label: "Delegating a Task" },
      expect.objectContaining({ _tag: "ToolAwaitingApproval", id: "call_1", approvalId: "a1" }),
      { _tag: "ToolFinished", id: "call_1", failed: false },
      expect.objectContaining({ _tag: "Completed", text: "Quill has it." }),
    ]);
    // The tools reach the hub on the App Server's channel: no MCP server, no hub address or token.
    const command = server.commands[0];
    expect(JSON.stringify(command?.args)).not.toContain("mcp_servers");
    expect(Object.keys(command?.env ?? {}).filter((name) => /HOBBOTS|HUB|TOKEN/i.test(name))).toEqual([]);
  });

  // covers PE-003, ADR 024
  it("[TC-RT-081] refuses a hub tool the turn does not offer, including on a resumed thread that offers none", async () => {
    hubCalls.length = 0;
    const offered = fakeServer({
      asks: [toolCall("call_1", "github_push")],
      script: [toolDone("call_1", "github_push", false), completed("completed")],
    });
    const refused = await run(config(offered.start), prompt({ hubTools: hub }));
    // The hub, not the tool's name, decided it.
    expect(hubCalls.map((call) => call.name)).toEqual(["github_push"]);
    expect(offered.answers[0]).toEqual({
      contentItems: [{ type: "inputText", text: "github_push is not offered." }],
      success: false,
    });
    expect(events(refused)).toContainEqual({ _tag: "ToolFinished", id: "call_1", failed: true });

    // The thread started with hub tools, and this turn offers none: Codex may still call one.
    const resumed = fakeServer({
      asks: [toolCall("call_2", "delegate_task", { hob: "Quill" })],
      script: [toolDone("call_2", "delegate_task", false), completed("completed")],
    });
    const exit = await run(config(resumed.start), prompt({ sessionId: THREAD }));
    expect(resumed.requests.find((request) => request.method === "thread/resume")?.params).not.toHaveProperty(
      "dynamicTools",
    );
    expect(resumed.answers[0]).toEqual({
      contentItems: [{ type: "inputText", text: notOffered("delegate_task") }],
      success: false,
    });
    expect(events(exit)).toContainEqual({
      _tag: "StepStarted",
      id: "call_2",
      kind: "tool",
      label: "Using delegate_task",
    });
    expect(hubCalls).toHaveLength(1);
  });

  // covers EX-004, IN-002, ADR 024
  it("[TC-RT-086] starts the turn only once the hub has taken the session, so no hub call comes before it", async () => {
    const server = fakeServer({ script: [completed("completed")] });
    let taken = false;
    let startedAfterTaken: boolean | undefined;
    const original = server.start;
    const watched: StartAppServer = (command, options) =>
      Effect.map(original(command, options), (app) => ({
        ...app,
        requestUnknown: (method: string, params: unknown) => {
          if (method === "turn/start") startedAfterTaken = taken;
          return app.requestUnknown(method, params);
        },
        request: ((method: string, params: unknown) => {
          if (method === "turn/start") startedAfterTaken = taken;
          return app.request(method as "turn/start", params as never);
        }) as AppServer["request"],
      }));
    await Effect.runPromise(
      runCodexTurn(config(watched), prompt({ hubTools: hub })).pipe(
        Stream.runForEach((event) =>
          event._tag === "SessionStarted"
            ? Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => (taken = true))))
            : Effect.void,
        ),
      ),
    );
    expect(startedAfterTaken).toBe(true);
  });

  // covers EX-004, ADR 024
  it("[TC-RT-082] marks a hub tool call uncertain when Codex stops before it recorded the answer", async () => {
    hubCalls.length = 0;
    const server = fakeServer({ asks: [toolCall("call_1", "delegate_task", { hob: "Quill" })], dies: true });
    const seen: Array<RuntimeEvent> = [];
    const exit = await Effect.runPromise(
      runCodexTurn(config(server.start), prompt({ hubTools: hub })).pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
        Effect.exit,
      ),
    );
    expect(exit).toEqual(Exit.fail(new RuntimeError({ message: LOST_TURN })));
    // The hub ran the call, but the hob never heard its answer: it must be checked before it runs again.
    expect(hubCalls).toHaveLength(1);
    expect(seen.filter((event) => event._tag !== "ToolAwaitingApproval")).toEqual([
      { _tag: "SessionStarted", sessionId: THREAD, billing: null },
      { _tag: "StepStarted", id: "call_1", kind: "tool", label: "Delegating a Task" },
      { _tag: "ToolUncertain", id: "call_1", reason: LOST_CALL },
    ]);
  });
});

describe("a Codex turn with tools", () => {
  // covers PE-005, ADR 014, ADR 024
  it("[TC-RT-067] starts Codex in the sandbox, in the hob's folder, with its home closed but for what it writes", async () => {
    const root = realpathSync(mkdtempSync(join(temp, "tools-")));
    const repository = join(root, "repo");
    const project = join(repository, "app");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(project);
    const runtimeFolder = join(root, "runtimes", "hob-1");
    const { home } = codexFolders(runtimeFolder);
    const scopes: Array<Omit<SandboxScope, "tempFolder">> = [];
    let released = 0;
    const sandbox: ProcessSandboxShape = {
      state: "on",
      evidence: "a stand-in sandbox",
      prepare: (scope) =>
        Effect.sync(() => {
          scopes.push(scope);
          return {
            // Like the wrap on macOS, it hands back what it was given and adds Claude Code's own settings.
            spawnArgs: (command, args, env) => ({
              command: "/sandbox",
              args: [command, ...args],
              env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "claude-sign-in", CLAUDE_CONFIG_DIR: runtimeFolder },
            }),
            release: () => {
              released += 1;
            },
          };
        }),
    };
    const engine = await Effect.runPromise(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));
    const binary = join(root, "codex");
    writeFileSync(binary, "");
    const server = fakeServer({ script: [completed("completed")] });
    const turnConfig: CodexTurnConfig = {
      ...config(server.start),
      binary: Effect.succeed(binary),
      policy: { engine, sandboxState: "on", sandbox },
    };
    const tools = {
      policy: {
        preset: "balanced",
        sharedFolders: [project],
        hob: EMPTY_HOB_POLICY,
        dataFolder: join(root, "data"),
        restrictions: [],
      },
      folders: [project],
      runtimeFolder,
    } as const;
    // The hub was started with Claude Code's sign-in, which Codex would hand to every command.
    const hubEnv = { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-sign-in";
    try {
      await run(turnConfig, prompt({ tools }));
    } finally {
      if (hubEnv.CLAUDE_CODE_OAUTH_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = hubEnv.CLAUDE_CODE_OAUTH_TOKEN;
    }
    // Neither Codex outside the sandbox nor inside it gets a Claude variable (STD-SEC-002).
    for (const command of server.commands) {
      expect(Object.keys(command.env).filter((key) => key.startsWith("CLAUDE_"))).toEqual([]);
      expect(Object.values(command.env)).not.toContain("claude-sign-in");
    }
    // Codex started once outside the sandbox to set up its home, then inside it for the turn.
    expect(server.commands.map((command) => command.command)).toEqual([binary, "/sandbox"]);
    expect(server.commands[1]).toMatchObject({ args: [binary, "app-server"], env: { CODEX_HOME: home }, cwd: project });
    expect(scopes).toEqual([
      expect.objectContaining({
        folders: [project],
        folderAccess: { read: true, write: true },
        runtimeFolder,
        runtimeAccess: { read: [join(home, "config.toml"), join(home, "rules")], write: codexWrites(runtimeFolder) },
        allowedHosts: CODEX_MODEL_HOSTS,
      }),
    ]);
    // What Codex writes it reads back, such as its state database, which on macOS needs both.
    const filesystem = sandboxFilesystem({ ...(scopes[0] as Omit<SandboxScope, "tempFolder">), tempFolder: temp });
    for (const path of codexWrites(runtimeFolder)) {
      expect(filesystem.allowWrite).toContain(path);
      expect(filesystem.allowRead).toContain(path);
    }
    // Codex makes its installation ID on its first start, outside the sandbox; the folders are made before it.
    for (const folder of codexWrites(runtimeFolder).filter((path) => !path.endsWith("installation_id"))) {
      expect(existsSync(folder)).toBe(true);
    }
    expect(released).toBe(1);
    // The folder and its repository are untrusted, so Codex loads no rules, hooks or MCP servers from them.
    const settings = readFileSync(join(home, "config.toml"), "utf8");
    expect(settings).toContain(`[projects.${JSON.stringify(project)}]\ntrust_level = "untrusted"`);
    expect(settings).toContain(`[projects.${JSON.stringify(repository)}]\ntrust_level = "untrusted"`);
    expect(settings).toContain("shell_tool = true");
    expect(server.requests.find((request) => request.method === "thread/start")).toMatchObject({
      params: { cwd: project, developerInstructions: expect.stringContaining(SANDBOX_NOTE) },
    });

    // Without a verified sandbox the policy decides commands as if it were missing, so Codex offers none.
    await run({ ...turnConfig, policy: { engine, sandboxState: "unavailable", sandbox } }, prompt({ tools }));
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("shell_tool = false");
  });
});

describe("who a Codex hob's commits are made as", () => {
  // covers OR-004
  it("[TC-RT-1019] commits as the identity the user gave Hobbots when their Git config sets none, and is told so (#741)", async () => {
    const root = realpathSync(mkdtempSync(join(temp, "identity-")));
    const project = join(root, "project");
    const home = join(root, "home");
    for (const folder of [project, home]) mkdirSync(folder);
    const sandbox: ProcessSandboxShape = {
      state: "on",
      evidence: "a stand-in sandbox",
      prepare: () =>
        Effect.succeed({
          spawnArgs: (command, args, env) => ({ command: "/sandbox", args: [command, ...args], env }),
          release: () => undefined,
        }),
    };
    const engine = await Effect.runPromise(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));
    const binary = join(root, "codex");
    writeFileSync(binary, "");
    const given = { name: "otaviobarros", email: "35647586+otaviobarros@users.noreply.github.com" };
    const tools = (userIdentity?: typeof given) => ({
      policy: {
        preset: "balanced" as const,
        sharedFolders: [project],
        hob: EMPTY_HOB_POLICY,
        dataFolder: join(root, "data"),
        restrictions: [],
      },
      folders: [project],
      runtimeFolder: join(root, "runtimes", "hob-1"),
      ...(userIdentity ? { userIdentity } : {}),
    });
    /** Starts a turn as the hub would, with the user's home holding no Git config, and returns what Codex got. */
    const launch = async (userIdentity?: typeof given, sessionId: string | null = null) => {
      const server = fakeServer({ script: [completed("completed")] });
      const turnConfig: CodexTurnConfig = {
        ...config(server.start),
        binary: Effect.succeed(binary),
        policy: { engine, sandboxState: "on", sandbox },
      };
      const before = process.env.HOME;
      process.env.HOME = home;
      try {
        await run(turnConfig, prompt({ tools: tools(userIdentity), sessionId }));
      } finally {
        process.env.HOME = before;
      }
      const started = server.requests.find((request) => request.method === "thread/start");
      const turn = server.requests.find((request) => request.method === "turn/start");
      return {
        prompt: JSON.stringify(turn?.params ?? {}),
        env: server.commands.at(-1)?.env ?? {},
        instructions: ((started?.params ?? {}) as { developerInstructions?: string }).developerInstructions ?? "",
      };
    };
    /** Commits as a command Codex runs would, with Codex's environment, and returns the author or Git's error. */
    const commit = (env: Record<string, string | undefined>) => {
      const repo = mkdtempSync(join(root, "repo-"));
      const run = { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
      execFileSync("git", ["init", "-q"], { cwd: repo, env: run });
      try {
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one"], { cwd: repo, env: run, stdio: "pipe" });
        return execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo, env: run }).toString().trim();
      } catch (error) {
        return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
      }
    };

    // No identity anywhere: Codex's commands cannot commit, and the hob is told not to and not to ask.
    const none = await launch();
    expect(none.instructions).toContain(NO_GIT_IDENTITY_NOTE);
    expect(commit(none.env)).toMatch(/^failed: .*no email was given/s);

    // The user gave Hobbots one: Codex's commands commit as it, and the hob is told so.
    const asGiven = await launch(given);
    expect(asGiven.instructions).toContain(`made as ${given.name} <${given.email}>`);
    expect(asGiven.instructions).not.toContain(NO_GIT_IDENTITY_NOTE);
    expect(commit(asGiven.env)).toBe(`${given.name} <${given.email}>`);

    // A Codex thread keeps the instructions it started with, so a resumed one started before you
    // answered is told in its prompt who it commits as now.
    const resumed = await launch(given, "thr-1");
    expect(resumed.prompt).toContain(`<commit-identity>\\nYour commits are made as ${given.name} <${given.email}>`);
    expect((await launch(undefined, "thr-1")).prompt).toContain("No Git identity is set for your commits yet");
  });
});

describe("reading a Codex turn", () => {
  it("shows reasoning as a thinking step, and leaves out other threads' notifications", () => {
    const read = codexTurnEvents(THREAD);
    expect(read.map(item("item/started", { type: "reasoning", id: "r1" })).events).toEqual([
      { _tag: "StepStarted", id: "r1", kind: "thinking", label: "Thinking" },
    ]);
    expect(
      read.map({
        ...delta("x", "sub-agent"),
        params: { threadId: "other", turnId: TURN, itemId: "x", delta: "no" },
      } as AppServerNotification).events,
    ).toEqual([]);
    expect(read.map(item("item/completed", { type: "reasoning", id: "r1" })).events).toEqual([
      { _tag: "StepEnded", id: "r1" },
    ]);
  });

  // regression for #1027
  it("[TC-RT-1020] reports a compacted thread, so the hub tells it again what it relied on it holding", () => {
    const read = codexTurnEvents(THREAD);
    expect(read.map(item("item/started", { type: "contextCompaction", id: "k1" })).events).toEqual([]);
    expect(read.map(item("item/completed", { type: "contextCompaction", id: "k1" })).events).toEqual([
      { _tag: "SessionCompacted" },
    ]);
  });

  it("reports a started call's live output and end, and marks it uncertain when Codex is lost", () => {
    const read = codexTurnEvents(THREAD);
    // Nobody decided this call, so nothing is reported for it.
    expect(read.map(n("item/commandExecution/outputDelta", { itemId: "c0", delta: "x" })).events).toEqual([]);
    read.started("c1");
    expect(read.map(n("item/commandExecution/outputDelta", { itemId: "c1", delta: "ok\n" })).events).toEqual([
      { _tag: "ToolOutput", id: "c1", text: "ok\n" },
    ]);
    expect(
      read.map(
        item("item/completed", {
          type: "commandExecution",
          id: "c1",
          status: "failed",
          aggregatedOutput: "ok\nboom\n",
          exitCode: 2,
        }),
      ).events,
    ).toEqual([{ _tag: "ToolFinished", id: "c1", failed: true, output: "ok\nboom\n", exitCode: 2 }]);
    read.started("c2");
    read.map(item("item/started", { type: "reasoning", id: "r1" }));
    expect(read.lost()).toEqual({
      events: [
        { _tag: "StepEnded", id: "r1" },
        { _tag: "ToolUncertain", id: "c2", reason: LOST_CALL },
      ],
      error: new RuntimeError({ message: LOST_TURN }),
    });
  });
});

/** The real sandbox: on macOS, or on Linux with HOBBOTS_SANDBOX_TESTS=1 and bubblewrap. */
const realSandbox = process.platform === "darwin" || process.env.HOBBOTS_SANDBOX_TESTS === "1";

describe.runIf(realSandbox)("Codex's command in the real sandbox", () => {
  // covers ADR 014, ADR 024, STD-SEC-002
  it("[TC-RT-071] keeps the turn's temporary folder and no Claude variable in the command that starts Codex", async () => {
    const root = realpathSync(mkdtempSync(join(temp, "launch-")));
    const project = join(root, "project");
    mkdirSync(project);
    const hubEnv = { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-sign-in";
    try {
      await Effect.gen(function* () {
        const sandbox = yield* ProcessSandbox;
        const prepared = yield* sandbox.prepare({
          folders: [project],
          folderAccess: { read: true, write: true },
          dataFolder: join(root, "data"),
          binary: "/bin/sh",
          runtimeFolder: join(root, "runtimes", "hob-1"),
          allowedHosts: [],
        });
        try {
          // Codex's command as a turn builds it, with a shell in Codex's place.
          const launch = sandboxedCommand(
            {
              command: "/bin/sh",
              args: ["-c", 'echo "$TMPDIR"; mktemp "$TMPDIR/tmp.XXXXXX"; env | cut -d= -f1 | grep "^CLAUDE_" || true'],
              env: { PATH: "/usr/bin:/bin", CODEX_HOME: join(root, "codex") },
              cwd: project,
            },
            prepared,
            undefined,
          );
          const ran = spawnSync(launch.command, [...launch.args], {
            cwd: project,
            env: launch.env,
            encoding: "utf8",
          });
          expect(ran.status, ran.stderr).toBe(0);
          const [folder, made, ...claude] = ran.stdout.trim().split("\n");
          // The launcher takes the turn's temporary folder back from sandbox-runtime's, and files can be made there.
          // (macOS's mktemp ignores TMPDIR without a template.)
          expect(folder).not.toBe("/tmp/claude");
          expect(made?.startsWith(`${folder}/`)).toBe(true);
          // sandbox-runtime adds its proxy ports inside the wrap; no Claude credential gets in.
          expect(claude.filter((key) => /TOKEN|SECRET|KEY|AUTH|CREDENTIAL/.test(key))).toEqual([]);
          expect(ran.stdout).not.toContain("claude-sign-in");
        } finally {
          prepared.release();
        }
      }).pipe(Effect.provide(ProcessSandbox.layer), Effect.scoped, Effect.runPromise);
    } finally {
      if (hubEnv.CLAUDE_CODE_OAUTH_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = hubEnv.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }, 30_000);
});
