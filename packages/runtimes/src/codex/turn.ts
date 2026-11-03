import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type PromptRequest, RuntimeError, type RuntimeEvent, type RuntimeLimitReached } from "@hobbots/agents";
import type { PolicyOperation } from "@hobbots/domain";
import { Deferred, type Duration, Effect, Queue, type Scope, Stream } from "effect";
import { turnPrompt } from "../claude-code.ts";
import { sandboxEnv } from "../sandbox.ts";
import { toolLabel } from "../tool-calls.ts";
import {
  type AppServer,
  type AppServerCommand,
  AppServerError,
  type AppServerOptions,
  type ServerRequestHandlers,
} from "./app-server.ts";
import type { ChatGptTokens } from "./auth.ts";
import { type CodexTurnEvents, codexTurnEvents, type TurnEnd } from "./events.ts";
import { callHubTool, dynamicToolsOf } from "./hub-tools.ts";
import { codexPath } from "./locate.ts";
import { TURN_SERVER_REQUESTS, type TurnServerRequest, type TurnStartResponse } from "./protocol.ts";

/** Starts a turn's App Server for as long as the scope lasts. */
export type StartAppServer = (
  command: AppServerCommand,
  options: AppServerOptions,
) => Effect.Effect<AppServer, AppServerError, Scope.Scope>;

/**
 * The turn's sign-in, handed over through the protocol and never written down (ADR 024): a fresh
 * access token from the hub's own App Server, outside the sandbox, each time it is read. Null when
 * the configured model provider needs none, as with a stand-in model.
 */
type TurnSignIn = (binary: string) => Effect.Effect<ChatGptTokens | null, RuntimeError>;

/** What a tool gate is given about the turn: its events, and how it reports a call. */
interface CodexToolTurn {
  readonly events: CodexTurnEvents;
  readonly report: (event: RuntimeEvent) => void;
  readonly redact: (text: string) => string;
}

/** A request Codex sends about a tool call it would run itself. Hub tool calls go to the hub instead. */
type ToolRequest = Exclude<
  TurnServerRequest,
  { readonly method: "account/chatgptAuthTokens/refresh" | "item/tool/call" }
>;

/**
 * Decides the tool calls Codex asks about: commands, file changes and MCP calls. The policy (#439)
 * plugs in here; until then every call is refused.
 */
type CodexToolGate = (request: ToolRequest, turn: CodexToolTurn) => Effect.Effect<unknown, RuntimeError>;

/** Why a Codex hob's tool calls are refused while Hobbots cannot yet enforce its policy on them. */
export const TOOLS_CLOSED =
  "Hobbots cannot enforce your permissions on Codex's tools yet, so this did not run. Answer without tools.";

const denied = (
  turn: CodexToolTurn,
  call: { readonly id: string; readonly tool: string; readonly operation: PolicyOperation; readonly label: string },
  targets: ReadonlyArray<string> = [],
) => turn.report({ _tag: "ToolDenied", ...call, targets, reason: TOOLS_CLOSED, decidedBy: "policy" });

/**
 * Refuses every tool call, reporting each as denied by the policy. Approvals are declined, never
 * cancelled, so the turn goes on and the model hears that the call did not run.
 */
const refuseTools: CodexToolGate = (request, turn) =>
  Effect.sync(() => {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const { itemId, command, cwd } = request.params;
        const label = toolLabel("Bash", command ? { command } : {}, turn.redact);
        denied(turn, { id: itemId, tool: "Bash", operation: "run-commands", label }, cwd ? [cwd] : []);
        return { decision: "decline" };
      }
      case "item/fileChange/requestApproval":
        denied(turn, {
          id: request.params.itemId,
          tool: "apply_patch",
          operation: "edit-files",
          label: "Changing files",
        });
        return { decision: "decline" };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
    }
  });

/** The rule every Codex turn's instructions end with (ADR 024): Codex's own trailer stays out. */
export const NO_ATTRIBUTION_NOTE =
  "Never add Codex attribution to commits or pull requests: no `Co-authored-by: Codex` trailer and no note that Codex made them.";

/** The instructions a Codex thread starts with, and that a changed hob carries inside its next turn. */
const codexInstructions = (instructions: string) =>
  [instructions, NO_ATTRIBUTION_NOTE].filter((part) => part !== "").join("\n\n");

/**
 * Codex's settings for a hob, written into its own `CODEX_HOME` before every turn (ADR 024): tools that
 * read or reach beyond the folders without asking are off, and so are Codex's own sub-agents. The
 * databases and logs live in a state folder of their own.
 */
const codexConfig = (state: string) =>
  [
    `sqlite_home = ${JSON.stringify(state)}`,
    `log_dir = ${JSON.stringify(join(state, "log"))}`,
    `web_search = "disabled"`,
    "",
    "[features]",
    "view_image = false",
    "multi_agent = false",
    "",
  ].join("\n");

/** Where Codex keeps a hob's threads (`CODEX_HOME`), and its databases and logs, in the hob's runtime folder. */
export const codexFolders = (runtimeFolder: string) => ({
  home: join(runtimeFolder, "codex"),
  state: join(runtimeFolder, "codex-state"),
});

const prepareHome = (runtimeFolder: string, workspaceDir: string) =>
  Effect.try({
    try: () => {
      mkdirSync(workspaceDir, { recursive: true });
      const { home, state } = codexFolders(runtimeFolder);
      // The hub keeps `rules/` empty, so no execution rule lets a command skip the policy (ADR 024).
      mkdirSync(join(home, "rules"), { recursive: true, mode: 0o700 });
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(join(home, "config.toml"), codexConfig(state), { mode: 0o600 });
      return home;
    },
    catch: (error) => new RuntimeError({ message: `Could not prepare Codex's folder: ${String(error)}` }),
  });

export interface CodexTurnConfig {
  /** The Codex binary to run, once found and checked. */
  readonly binary: Effect.Effect<string, RuntimeError>;
  readonly start: StartAppServer;
  readonly signIn: TurnSignIn;
  /** Hobbots' version, which Codex adds to its user agent. */
  readonly clientVersion: string;
  /**
   * Where a chat-only turn starts, and where Codex keeps the threads of a turn the hub gave no
   * runtime folder.
   */
  readonly workspaceDir: string;
  /** Decides tool calls; by default every one is refused. */
  readonly tools?: CodexToolGate;
  /** How long a cancelled turn waits for Codex's acknowledgement before its process is ended. */
  readonly interruptGrace?: Duration.Input;
  /** More `codex app-server` arguments, such as `-c` settings for a stand-in model. */
  readonly extraArgs?: ReadonlyArray<string>;
}

/** The settings every turn applies (ADR 024): ask about every call, Hobbots' sandbox around Codex's. */
const THREAD_SETTINGS = { approvalPolicy: "untrusted", sandbox: "danger-full-access" } as const;
const TURN_SETTINGS = {
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
} as const;

/** Where the turn is billed, in the words provider health uses. */
const billingOf = (tokens: ChatGptTokens | null) =>
  tokens === null ? null : `subscription (${tokens.chatgptPlanType ?? "ChatGPT"})`;

const failed = (error: AppServerError | RuntimeError) =>
  error._tag === "RuntimeError" ? error : new RuntimeError({ message: error.message });

/** What Codex may ask a turn's client, and how each is answered; anything else is refused. */
const requestHandlers = (
  config: CodexTurnConfig,
  binary: string,
  hub: PromptRequest["hubTools"],
  turn: () => CodexToolTurn | undefined,
): ServerRequestHandlers => {
  const answer = (request: TurnServerRequest): Effect.Effect<unknown, RuntimeError> => {
    if (request.method === "account/chatgptAuthTokens/refresh") {
      return config
        .signIn(binary)
        .pipe(
          Effect.flatMap((tokens) =>
            tokens === null
              ? Effect.fail(new RuntimeError({ message: "Codex asked for a sign-in this turn does not use." }))
              : Effect.succeed(tokens),
          ),
        );
    }
    const current = turn();
    // Codex asks about calls only while a turn runs, which is after its thread is open.
    if (current === undefined) return Effect.fail(new RuntimeError({ message: "No Codex turn is running." }));
    // Hub tools reach the hub on this channel, so the sandbox holds no hub address or token (ADR 024).
    if (request.method === "item/tool/call") return callHubTool(hub, request.params, current);
    return (config.tools ?? refuseTools)(request, current);
  };
  return Object.fromEntries(
    TURN_SERVER_REQUESTS.map((method) => [
      method,
      (params: unknown) =>
        answer({ method, params } as TurnServerRequest).pipe(
          Effect.mapError((error) => new AppServerError({ message: error.message })),
        ),
    ]),
  );
};

/**
 * Opens the turn's Codex thread: resumes the Hobbots thread's session, or starts one with the turn's
 * hub tools. A resumed thread keeps the hub tools it started with, since `thread/resume` takes none.
 */
const openThread = (server: AppServer, request: PromptRequest, cwd: string, instructions: string) => {
  const model = request.model ? { model: request.model } : {};
  return request.sessionId
    ? server.request("thread/resume", {
        threadId: request.sessionId,
        cwd,
        ...THREAD_SETTINGS,
        ...model,
        excludeTurns: true,
      })
    : server.request("thread/start", {
        cwd,
        ...THREAD_SETTINGS,
        ...model,
        developerInstructions: instructions,
        dynamicTools: dynamicToolsOf(request.hubTools),
      });
};

/** Reads the turn's notifications into events, until the turn ends or the App Server exits. */
const follow = (
  notifications: Stream.Stream<{ readonly method: string; readonly params: unknown }>,
  mapper: CodexTurnEvents,
  report: (event: RuntimeEvent) => void,
  ended: Deferred.Deferred<TurnEnd | "lost">,
) =>
  notifications.pipe(
    Stream.runForEach((notification) =>
      Effect.gen(function* () {
        const step = mapper.map(notification);
        for (const event of step.events) report(event);
        if (step.end) yield* Deferred.succeed(ended, step.end);
      }),
    ),
    Effect.andThen(Deferred.succeed(ended, "lost")),
  );

/** Ends the stream as the turn ended. */
const finish = (
  end: TurnEnd | "lost",
  mapper: CodexTurnEvents,
  report: (event: RuntimeEvent) => void,
  done: Effect.Effect<void>,
) => {
  if (end === "lost") {
    const lost = mapper.lost();
    for (const event of lost.events) report(event);
    return Effect.fail(lost.error);
  }
  switch (end._tag) {
    case "Completed":
      report(end.event);
      return done;
    case "Failed":
      return Effect.fail(end.error);
    case "Interrupted":
      // Hobbots did not cancel it, so the reply is not done.
      return Effect.fail(new RuntimeError({ message: "Codex stopped the turn before it finished." }));
  }
};

/** The turn's events, which start the turn only once `accepted` holds. */
const turnEvents = (
  config: CodexTurnConfig,
  request: PromptRequest,
  accepted: Deferred.Deferred<void>,
): Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached> =>
  Stream.callback<RuntimeEvent, RuntimeError | RuntimeLimitReached>((queue) =>
    Effect.gen(function* () {
      const report = (event: RuntimeEvent) => Queue.offerUnsafe(queue, event);
      const binary = yield* config.binary;
      const home = yield* prepareHome(
        request.tools?.runtimeFolder ?? join(config.workspaceDir, "codex-chat"),
        config.workspaceDir,
      );
      const instructions = codexInstructions(request.instructions);
      const cwd = config.workspaceDir;
      // A tool gate needs the turn's events, which need its thread, which only Codex names.
      let turn: CodexToolTurn | undefined;
      const server = yield* config
        .start(
          {
            command: binary,
            args: ["app-server", ...(config.extraArgs ?? [])],
            // Only named variables reach Codex, which hands its whole environment to its commands (ADR 014).
            env: {
              ...(sandboxEnv(process.env) as Record<string, string>),
              PATH: codexPath(binary, process.env, homedir()),
              CODEX_HOME: home,
            },
            cwd,
          },
          {
            handlers: requestHandlers(config, binary, request.hubTools, () => turn),
            clientVersion: config.clientVersion,
          },
        )
        .pipe(Effect.mapError(failed));

      const tokens = yield* config.signIn(binary);
      if (tokens !== null) {
        yield* server
          .request("account/login/start", { type: "chatgptAuthTokens", ...tokens })
          .pipe(Effect.mapError(failed));
      }
      const opened = yield* openThread(server, request, cwd, instructions).pipe(Effect.mapError(failed));
      const threadId = opened.thread.id;
      const mapper = codexTurnEvents(threadId);
      turn = { events: mapper, report, redact: request.redaction?.text ?? ((text) => text) };
      report({ _tag: "SessionStarted", sessionId: threadId, billing: billingOf(tokens) });
      yield* Deferred.await(accepted);

      // Subscribed before the turn starts, so its first notifications are not missed.
      const notifications = yield* server.subscribe;
      const ended = yield* Deferred.make<TurnEnd | "lost">();
      yield* Effect.forkScoped(follow(notifications, mapper, report, ended));

      const started: TurnStartResponse = yield* server
        .request("turn/start", {
          threadId,
          input: [{ type: "text", text: turnPrompt(request, instructions), text_elements: [] }],
          ...TURN_SETTINGS,
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
        })
        .pipe(Effect.mapError(failed));
      mapper.follow(started.turn.id);

      // Cancelling the turn asks Codex to stop it and waits for the acknowledgement, so the process
      // ends only once what it ran has stopped (ADR 024). It runs before the reader stops.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(ended)) return;
          // One deadline covers the request and its acknowledgement, so a Codex that stops answering
          // still has its process ended.
          yield* server
            .request("turn/interrupt", { threadId, turnId: started.turn.id })
            .pipe(
              Effect.ignore,
              Effect.andThen(Deferred.await(ended)),
              Effect.timeout(config.interruptGrace ?? "10 seconds"),
              Effect.ignore,
            );
        }),
      );

      return yield* finish(yield* Deferred.await(ended), mapper, report, Queue.end(queue));
    }),
  );

/**
 * Runs one turn on Codex (ADR 024): its own App Server process, signed in through the protocol, on
 * the Hobbots thread's Codex thread. Interrupting the stream sends `turn/interrupt` and waits for
 * `turn/completed` to acknowledge it; an App Server that exits first ends the turn as uncertain.
 */
export const runCodexTurn = (
  config: CodexTurnConfig,
  request: PromptRequest,
): Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached> =>
  Stream.unwrap(
    Effect.map(Deferred.make<void>(), (accepted) =>
      // The turn starts once the hub has taken `SessionStarted`: it accepts the work the turn carries
      // then, and a hub tool call that came first would find that work not yet accepted. The stream is
      // pulled one event at a time, so pulling past that event means the hub is done with it.
      turnEvents(config, request, accepted).pipe(
        Stream.flatMap(
          (event): Stream.Stream<RuntimeEvent> =>
            event._tag === "SessionStarted"
              ? Stream.concat(Stream.make(event), Stream.fromEffectDrain(Deferred.succeed(accepted, undefined)))
              : Stream.make(event),
        ),
      ),
    ),
  );
