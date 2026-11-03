import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PromptRequest, RuntimeError, type RuntimeEvent, RuntimeLimitReached } from "@hobbots/agents";
import { Effect, Exit, Fiber, PubSub, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { AppServer, AppServerCommand, AppServerNotification } from "../src/codex/app-server.ts";
import type { ChatGptTokens } from "../src/codex/auth.ts";
import { codexTurnEvents, LOST_CALL, LOST_TURN } from "../src/codex/events.ts";
import {
  type CodexTurnConfig,
  codexFolders,
  NO_ATTRIBUTION_NOTE,
  runCodexTurn,
  type StartAppServer,
  TOOLS_CLOSED,
} from "../src/codex/turn.ts";

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
  it("[TC-RT-025] refuses every tool call while the policy is not enforced on Codex, and the turn goes on", async () => {
    const ask = (method: string, params: Record<string, unknown>) => ({
      method,
      params: { threadId: THREAD, turnId: TURN, ...params },
    });
    const server = fakeServer({
      asks: [
        ask("item/commandExecution/requestApproval", { itemId: "c1", command: "ls -la", cwd: "/w" }),
        ask("item/fileChange/requestApproval", { itemId: "f1" }),
        ask("mcpServer/elicitation/request", { serverName: "s", mode: "form" }),
        ask("item/tool/call", { callId: "t1", tool: "delegate", arguments: {} }),
        ask("item/permissions/requestApproval", { itemId: "p1" }),
      ],
      script: [message("m1", "I could not run it."), completed("completed")],
    });
    const exit = await run(config(server.start));
    expect(server.answers.slice(0, 4)).toEqual([
      { decision: "decline" },
      { decision: "decline" },
      { action: "decline", content: null, _meta: null },
      { contentItems: [{ type: "inputText", text: TOOLS_CLOSED }], success: false },
    ]);
    // Anything else Codex asks the client fails, which Codex takes as refused.
    expect(server.answers[4]).toEqual({ refused: "no handler" });
    const denied = events(exit).filter((event) => event._tag === "ToolDenied");
    expect(denied).toEqual([
      expect.objectContaining({
        id: "c1",
        tool: "Bash",
        operation: "run-commands",
        label: "Running ls -la",
        targets: ["/w"],
      }),
      expect.objectContaining({ id: "f1", tool: "apply_patch", operation: "edit-files", decidedBy: "policy" }),
      expect.objectContaining({ id: "t1", tool: "delegate", reason: TOOLS_CLOSED }),
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
