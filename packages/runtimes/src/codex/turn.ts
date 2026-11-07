import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type PromptRequest, RuntimeError, type RuntimeEvent, type RuntimeLimitReached } from "@hobbots/agents";
import type { AnyOperation, SandboxState } from "@hobbots/domain";
import type { PolicyEngine } from "@hobbots/permissions";
import { Deferred, type Duration, Effect, Queue, type Scope, Stream } from "effect";
import { grantedHosts } from "../approval.ts";
import {
  sessionPolicy,
  type ToolTurn,
  toolTurn,
  turnInstructions,
  turnPrompt,
  turnSigningAgent,
} from "../claude-code.ts";
import { turnCommits } from "../git-config.ts";
import {
  folderAccessFor,
  type PreparedSandbox,
  type ProcessSandboxShape,
  sandboxEnv,
  withCommitIdentity,
} from "../sandbox.ts";
import { askedMount, holdSkillFolder, type SkillFolder, skillFolderScope } from "../skills.ts";
import { offeredTools, toolLabel } from "../tool-calls.ts";
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
import { codexCaBundle, codexPath } from "./locate.ts";
import { POLICY_REQUESTS, type PolicyRequest, policyGate, refusalNotice, shellScript } from "./policy.ts";
import { TURN_SERVER_REQUESTS, type TurnServerRequest, type TurnStartResponse } from "./protocol.ts";
import {
  admitSkills,
  askedSkillInput,
  setSkillFilesOf,
  skillRootsOf,
  skillSettings,
  unusedSkillRoots,
} from "./skills.ts";

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

/** What a tool gate is given about the turn: its events, how it reports a call, and the gate itself. */
interface CodexToolTurn {
  readonly events: CodexTurnEvents;
  readonly report: (event: RuntimeEvent) => void;
  readonly redact: (text: string) => string;
  /** Adds a note to a running turn, which the model reads with its next request (#1082). */
  readonly tell: (turnId: string, text: string) => Effect.Effect<void>;
  /** Decides the turn's tool calls: the policy for a turn with tools, otherwise every one is refused. */
  readonly gate: CodexToolGate;
}

/** A request Codex sends about a tool call it would run itself. Hub tool calls go to the hub instead. */
type ToolRequest = Exclude<
  TurnServerRequest,
  { readonly method: "account/chatgptAuthTokens/refresh" | "item/tool/call" }
>;

/** Decides the tool calls Codex asks about: commands, file changes and MCP calls. */
type CodexToolGate = (request: ToolRequest, turn: CodexToolTurn) => Effect.Effect<unknown, RuntimeError>;

/** Why a tool call is refused on a turn without tools. */
export const TOOLS_CLOSED = "You have no tools in this conversation, so this did not run. Answer without tools.";

const denied = (
  turn: CodexToolTurn,
  call: { readonly id: string; readonly tool: string; readonly operation: AnyOperation; readonly label: string },
  targets: ReadonlyArray<string> = [],
) => turn.report({ _tag: "ToolDenied", ...call, targets, reason: TOOLS_CLOSED, decidedBy: "policy" });

/**
 * Refuses every tool call, as on a turn without tools, reporting each as denied by the policy.
 * Approvals are declined, never cancelled, so the turn goes on and the model hears that the call did
 * not run, and why.
 */
const refuseTools: CodexToolGate = (request, turn) => {
  const closed = (turnId: string, call: string) =>
    turn.tell(turnId, refusalNotice(call, TOOLS_CLOSED, "policy")).pipe(Effect.as({ decision: "decline" }));
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const { itemId, command, cwd } = request.params;
      const label = toolLabel("Bash", command ? { command } : {}, turn.redact);
      denied(turn, { id: itemId, tool: "Bash", operation: "run-commands", label }, cwd ? [cwd] : []);
      return closed(request.params.turnId, command ? turn.redact(shellScript(command)) : label);
    }
    case "item/fileChange/requestApproval":
      denied(turn, {
        id: request.params.itemId,
        tool: "apply_patch",
        operation: "edit-files",
        label: "Changing files",
      });
      return closed(request.params.turnId, "Changing files");
    case "mcpServer/elicitation/request":
      return Effect.succeed({ action: "decline", content: null, _meta: null });
  }
};

/** The rule every Codex turn's instructions end with (ADR 024): Codex's own trailer stays out. */
export const NO_ATTRIBUTION_NOTE =
  "Never add Codex attribution to commits or pull requests: no `Co-authored-by: Codex` trailer and no note that Codex made them.";

/**
 * The instructions a Codex thread starts with, and that a changed hob carries inside its next turn:
 * the hob's own, the notes a turn with tools gets as on Claude Code, and the no-attribution rule.
 */
const codexInstructions = (instructions: string) =>
  [instructions, NO_ATTRIBUTION_NOTE].filter((part) => part !== "").join("\n\n");

/** The Git repository a folder is in, by the folder that holds its `.git`, or undefined outside one. */
const repositoryRoot = (folder: string): string | undefined => {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
};

/** What a turn's Codex settings depend on. */
interface CodexSettings {
  /** The hob's folders, which Codex must load no project configuration from. */
  readonly folders: ReadonlyArray<string>;
  /** Whether Codex offers its shell tool: only when the policy would let a command run. */
  readonly shell: boolean;
}

/**
 * Codex's settings for a hob, written into its own `CODEX_HOME` before every turn (ADR 024): tools that
 * read or reach beyond the folders without asking are off, and so are Codex's own sub-agents. The
 * databases and logs live in a state folder of their own. Each folder, and the repository it is in,
 * is untrusted, so Codex loads no execution rules, hooks or MCP servers from it.
 */
const codexConfig = (state: string, settings: CodexSettings) => {
  const untrusted = [
    ...new Set(settings.folders.flatMap((folder) => [folder, repositoryRoot(folder) ?? folder])),
  ].flatMap((folder) => [`[projects.${JSON.stringify(folder)}]`, `trust_level = "untrusted"`, ""]);
  return [
    `sqlite_home = ${JSON.stringify(state)}`,
    `log_dir = ${JSON.stringify(join(state, "log"))}`,
    `web_search = "disabled"`,
    "",
    "[features]",
    "view_image = false",
    "multi_agent = false",
    `shell_tool = ${settings.shell}`,
    "",
    ...untrusted,
  ].join("\n");
};

/** Where Codex keeps a hob's threads (`CODEX_HOME`), and its databases and logs, in the hob's runtime folder. */
export const codexFolders = (runtimeFolder: string) => ({
  home: join(runtimeFolder, "codex"),
  state: join(runtimeFolder, "codex-state"),
});

/** The folders Codex writes in its home: its threads, shell snapshots, locks and helper programs. */
const HOME_FOLDERS = ["sessions", "shell_snapshots", "thread-writer-locks", ".tmp", "tmp"];

/** The files it writes there: its installation's ID, which it opens for writing at every start. */
const HOME_FILES = ["installation_id"];

const HOME_WRITES = [...HOME_FOLDERS, ...HOME_FILES];

/**
 * The only places a sandboxed Codex may write in its home, beside its state folder (ADR 024). The
 * rest, its configuration, execution rules and skills among them, stays read-only, so nothing a turn
 * runs can change what later turns load.
 */
export const codexWrites = (runtimeFolder: string): ReadonlyArray<string> => {
  const { home, state } = codexFolders(runtimeFolder);
  return [...HOME_WRITES.map((folder) => join(home, folder)), state];
};

/** What else a sandboxed Codex reads in its home: everything there now but what it writes. */
const codexReads = (runtimeFolder: string): ReadonlyArray<string> => {
  const { home } = codexFolders(runtimeFolder);
  return readdirSync(home)
    .sort()
    .filter((entry) => !HOME_WRITES.includes(entry))
    .map((entry) => join(home, entry));
};

const prepareHome = (runtimeFolder: string, workspaceDir: string, settings: CodexSettings) =>
  Effect.try({
    try: () => {
      mkdirSync(workspaceDir, { recursive: true });
      const { home, state } = codexFolders(runtimeFolder);
      // The hub keeps `rules/` empty, so no execution rule lets a command skip the policy (ADR 024).
      mkdirSync(join(home, "rules"), { recursive: true, mode: 0o700 });
      // The sandbox opens only folders that exist when it starts.
      for (const folder of [...HOME_FOLDERS.map((name) => join(home, name)), state]) {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
      }
      writeFileSync(join(home, "config.toml"), codexConfig(state, settings), { mode: 0o600 });
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
  /**
   * Decides the tool calls of a turn with tools under the hob's policy (ADR 014). Absent, every turn
   * is chat-only and every call is refused.
   */
  readonly policy?: CodexPolicy;
  /** How long a cancelled turn waits for Codex's acknowledgement before its process is ended. */
  readonly interruptGrace?: Duration.Input;
  /** The user's home folder, whose `~/.agents/skills` Codex lists (ADR 029); the system's by default. */
  readonly userHome?: string;
  /** More `codex app-server` arguments, such as `-c` settings for a stand-in model. */
  readonly extraArgs?: ReadonlyArray<string>;
}

/** How a turn with tools is decided and confined. */
interface CodexPolicy {
  readonly engine: PolicyEngine["Service"];
  /** The sandbox the policy decides under: "on" only once it is verified on this hub (ADR 014). */
  readonly sandboxState: SandboxState;
  /** The sandbox Codex starts in when it started on this hub, verified or not. */
  readonly sandbox: ProcessSandboxShape;
}

/**
 * Hosts Codex reaches for its model with a ChatGPT sign-in. Its sign-in is refreshed outside the
 * sandbox (ADR 024), so the sign-in hosts stay closed.
 */
export const CODEX_MODEL_HOSTS: ReadonlyArray<string> = ["chatgpt.com", "api.openai.com"];

/**
 * What must stay readable for Codex to start. An npm install runs a script whose platform binary is
 * a package of its own, inside the script's package or beside it under `@openai`, so all of
 * `@openai` opens.
 */
const codexPackage = (binary: string): ReadonlyArray<string> => {
  const real = realpathSync(binary);
  if (!real.endsWith(join("bin", "codex.js"))) return [];
  const root = dirname(dirname(real));
  return basename(dirname(root)) === "@openai" ? [dirname(root)] : [root];
};

/** The CA bundle Codex is given, which must stay readable in the sandbox. */
const caFiles = (): ReadonlyArray<string> => {
  const bundle = codexCaBundle();
  return bundle ? [bundle] : [];
};

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
    return current.gate(request, current);
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
        // A turn of no hob's keeps no thread on disk.
        ...(request.ephemeral ? { ephemeral: true } : {}),
      });
};

/**
 * What the turn's notifications signal: a Codex turn's end, the App Server's exit, or the end of a
 * command that outlived its Codex turn (#1048).
 */
type TurnSignal = TurnEnd | "lost" | "commandEnded";

/** Reads the turn's notifications into events and signals, until the App Server exits. */
const follow = (
  notifications: Stream.Stream<{ readonly method: string; readonly params: unknown }>,
  mapper: CodexTurnEvents,
  report: (event: RuntimeEvent) => void,
  signals: Queue.Queue<TurnSignal>,
  now: CodexTurnNow,
) =>
  notifications.pipe(
    Stream.runForEach((notification) =>
      Effect.gen(function* () {
        const step = mapper.map(notification);
        for (const event of step.events) report(event);
        if (step.end) {
          yield* Deferred.succeed(now.ended, undefined);
          yield* Queue.offer(signals, step.end);
        } else if (step.commandEnded) {
          yield* Queue.offer(signals, "commandEnded");
        }
      }),
    ),
    Effect.andThen(Deferred.succeed(now.ended, undefined)),
    Effect.andThen(Queue.offer(signals, "lost")),
  );

/**
 * The Codex turn running now, or null while Hobbots waits for a command that outlived one, and
 * whether it has ended, which the reply's wait and its cancelling each hear of.
 */
interface CodexTurnNow {
  turnId: string | null;
  ended: Deferred.Deferred<void>;
}

/**
 * Waits for the end of the hob's reply (#1048). A Codex turn that completes while a command it
 * started still runs has not ended it: Codex keeps the command running, so Hobbots waits for it and
 * then tells the hob in a follow-up turn how it ended, as Claude Code wakes the session when a
 * background command ends (#1018). The reply ends once a Codex turn completes with none left.
 */
const settle = <E>(
  signals: Queue.Queue<TurnSignal>,
  mapper: CodexTurnEvents,
  now: CodexTurnNow,
  followUp: (notice: string) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    while (true) {
      const signal = yield* Queue.take(signals);
      // A Codex turn that is running hears of a command's end once it completes.
      if (signal === "commandEnded" && now.turnId !== null) continue;
      // No Codex turn runs from here, so cancelling has none to interrupt.
      now.turnId = null;
      if (signal === "lost" || (signal !== "commandEnded" && signal._tag !== "Completed")) return signal;
      const after = mapper.afterTurn();
      if (after.notice !== null) yield* followUp(after.notice);
      else if (!after.waiting) return { _tag: "Completed" } as const;
    }
  });

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
      report(mapper.reply());
      return done;
    case "Failed":
      return Effect.fail(end.error);
    case "Interrupted":
      // Hobbots did not cancel it, so the reply is not done.
      return Effect.fail(new RuntimeError({ message: "Codex stopped the turn before it finished." }));
  }
};

/** Decides commands and file changes with the policy; anything else as on a turn without tools. */
const withPolicy =
  (decide: ReturnType<typeof policyGate>): CodexToolGate =>
  (request, turn) =>
    (POLICY_REQUESTS as ReadonlyArray<string>).includes(request.method)
      ? decide(request as PolicyRequest, turn)
      : refuseTools(request, turn);

/**
 * Starts Codex once outside the sandbox before a hob's first sandboxed turn, so the files it makes in
 * its home on first start exist before the sandbox makes the home read-only (ADR 024).
 */
const firstStart = (config: CodexTurnConfig, command: AppServerCommand, home: string) =>
  existsSync(join(home, "installation_id"))
    ? Effect.void
    : config.start(command, { clientVersion: config.clientVersion }).pipe(
        Effect.flatMap((server) => server.request("model/list", {})),
        Effect.scoped,
        Effect.mapError(failed),
      );

/**
 * Prepares the sandbox Codex runs in for one turn (ADR 014, ADR 024): the hob's folders as the
 * policy opens them, Codex's model hosts, and in the hob's runtime folder only what Codex must write.
 */
const prepareSandbox = (
  sandbox: ProcessSandboxShape,
  tools: ToolTurn,
  request: PromptRequest,
  policy: CodexPolicy,
  binary: string,
  runtimeFolder: string,
  skills: SkillFolder | null,
) =>
  Effect.gen(function* () {
    // The sandbox opens the binary's folder and its real location's, so it must be a path that exists.
    const { files, reads } = yield* Effect.try({
      try: () => ({ files: [...codexPackage(binary), ...caFiles()], reads: codexReads(runtimeFolder) }),
      catch: () => new RuntimeError({ message: `Could not find ${binary}, so the sandbox cannot start it.` }),
    });
    const signingAgent = turnSigningAgent(tools);
    return yield* sandbox.prepare({
      folders: tools.folders,
      folderAccess: folderAccessFor(tools.context),
      dataFolder: tools.context.dataFolder,
      binary,
      runtimeFolder,
      runtimeAccess: { read: reads, write: codexWrites(runtimeFolder) },
      runtimeFiles: files,
      ...(signingAgent ? { signingAgent } : {}),
      ...(tools.commitAs ? { commitAs: tools.commitAs } : {}),
      ...skillFolderScope(skills),
      allowedHosts: CODEX_MODEL_HOSTS,
      decideHost: grantedHosts(policy.engine, tools.context, request.approvals),
    });
  });

/**
 * An environment without Claude Code's variables. The sandbox passes Claude Code's sign-in on for
 * Claude Code, which keeps it from its commands itself; Codex hands every variable to its commands,
 * so none of them reaches Codex (STD-SEC-002).
 */
const withoutClaude = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("CLAUDE_"),
    ),
  );

/**
 * The command that starts Codex in the turn's sandbox, or as it is, committing as the hob's bot if it
 * has one, and otherwise as the user (`userEnv`, #586, #741): Codex hands its environment to its commands.
 */
export const sandboxedCommand = (
  command: AppServerCommand,
  prepared: PreparedSandbox | null,
  commitAs: ToolTurn["commitAs"],
  userEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = (env) => env,
): AppServerCommand => {
  if (prepared === null) {
    return { ...command, env: userEnv(withCommitIdentity(command.env, commitAs)) as Record<string, string> };
  }
  const wrapped = prepared.spawnArgs(command.command, command.args, command.env);
  return {
    command: wrapped.command,
    args: wrapped.args,
    // Codex's home and CA bundle are not variables the sandbox passes on by itself. What the wrap adds
    // for Claude Code stays out, and with it any Claude credential it brings back.
    env: {
      ...withoutClaude(userEnv(wrapped.env)),
      CODEX_HOME: command.env.CODEX_HOME as string,
      ...(command.env.CODEX_CA_CERTIFICATE ? { CODEX_CA_CERTIFICATE: command.env.CODEX_CA_CERTIFICATE } : {}),
    },
    cwd: command.cwd,
  };
};

/**
 * How a turn starts Codex: in the hob's first folder with tools, or the hub's own folder without,
 * with the instructions a turn with tools gets, inside the sandbox when it started on this hub, and
 * with its calls decided by the policy (ADR 014, ADR 024).
 */
const prepareLaunch = (config: CodexTurnConfig, request: PromptRequest, binary: string) =>
  Effect.gen(function* () {
    const governed = governedTurn(config, request);
    const runtimeFolder = request.tools?.runtimeFolder ?? join(config.workspaceDir, "codex-chat");
    const home = yield* prepareHome(runtimeFolder, config.workspaceDir, codexSettings(governed));
    const cwd = governed?.tools.folders[0] ?? config.workspaceDir;
    // The turn's skills, in a folder of their own for as long as it runs, and every other skill Codex
    // would list turned off (ADR 029).
    const skills = yield* holdSkillFolder(runtimeFolder, request.skills);
    const skillArgs = yield* Effect.try({
      try: () => skillSettings(unusedSkillRoots(home, cwd, repositoryRoot(cwd), config.userHome)),
      catch: (error) => new RuntimeError({ message: `Could not read the skills Codex would load: ${String(error)}` }),
    });
    const command = appServerCommand(config, binary, home, cwd, skillArgs);
    if (governed === null) {
      return {
        command,
        cwd,
        skills,
        instructions: codexInstructions(turnInstructions(request.instructions, false)),
        commits: "",
        gate: refuseTools,
        session: {},
      };
    }
    const { tools, sandbox, policy, commits } = governed;
    const prepared = yield* sandboxFor(config, governed, request, command, runtimeFolder, skills);
    return {
      command: sandboxedCommand(command, prepared, tools.commitAs, commits.env),
      cwd,
      skills,
      instructions: codexInstructions(
        turnInstructions(
          request.instructions,
          sandbox !== null,
          Boolean(request.approvals),
          tools.commitAs,
          commits.note,
        ),
      ),
      commits: commits.now,
      gate: withPolicy(policyGate(policy.engine, tools, request, sandbox !== null)),
      session: sessionPolicy(tools),
    };
  });

/** Codex's settings for the turn: its folders untrusted, and its shell offered only when commands may run. */
const codexSettings = (governed: ReturnType<typeof governedTurn>): CodexSettings => ({
  folders: governed?.tools.folders ?? [],
  shell: governed !== null && offeredTools(governed.tools.context).includes("Bash"),
});

/**
 * The sandbox prepared for the turn, released when the turn ends, or null when none started on this
 * hub. Codex first starts once outside it if it never has, so its home is set up.
 */
const sandboxFor = (
  config: CodexTurnConfig,
  governed: NonNullable<ReturnType<typeof governedTurn>>,
  request: PromptRequest,
  command: AppServerCommand,
  runtimeFolder: string,
  skills: SkillFolder | null,
) => {
  const { sandbox, tools, policy } = governed;
  if (sandbox === null) return Effect.succeed(null);
  return Effect.acquireRelease(
    Effect.flatMap(firstStart(config, command, command.env.CODEX_HOME as string), () =>
      prepareSandbox(sandbox, tools, request, policy, command.command, runtimeFolder, skills),
    ),
    (prepared) => Effect.sync(prepared.release),
  );
};

/**
 * The turn's tools under the hob's policy, and the sandbox Codex starts in, or null for a turn
 * without tools. A sandbox that started wraps Codex even before it is verified here, as on Claude
 * Code (ADR 014).
 */
const governedTurn = (config: CodexTurnConfig, request: PromptRequest) => {
  const policy = config.policy;
  // Who its commits are made as, as on Claude Code (#586, #741).
  const tools = policy ? toolTurn(request.tools, policy.sandboxState, request.hubTools, CODEX_MODEL_HOSTS) : null;
  const commits = turnCommits(tools);
  if (!policy || tools === null) return null;
  return { policy, tools, commits, sandbox: policy.sandbox.state === "on" ? policy.sandbox : null };
};

/** Codex's CA bundle, which wins over `SSL_CERT_FILE` and adds to the roots Codex loads itself. */
const caVariable = (): Record<string, string> => {
  const bundle = codexCaBundle();
  return bundle ? { CODEX_CA_CERTIFICATE: bundle } : {};
};

/**
 * Starts `codex app-server` in `cwd` with its own home, the turn's skill settings and only named
 * variables (ADR 014, ADR 029).
 */
const appServerCommand = (
  config: CodexTurnConfig,
  binary: string,
  home: string,
  cwd: string,
  skillArgs: ReadonlyArray<string>,
): AppServerCommand => ({
  command: binary,
  args: ["app-server", ...skillArgs, ...(config.extraArgs ?? [])],
  // Codex hands its whole environment to its commands, so Claude Code's sign-in and settings stay out.
  env: {
    ...withoutClaude(sandboxEnv(process.env)),
    PATH: codexPath(binary, process.env, homedir()),
    CODEX_HOME: home,
    ...caVariable(),
  },
  cwd,
});

/**
 * Adds a note to a running Codex turn with `turn/steer`, which the model reads with its next request
 * (#1082). A note Codex refuses, as when the turn has ended, is left out: the call it explains is
 * still refused, and its step keeps the reason.
 */
const tellTurn =
  (server: AppServer, threadId: string) =>
  (turnId: string, text: string): Effect.Effect<void> =>
    server
      .request("turn/steer", { threadId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: turnId })
      .pipe(Effect.ignore);

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
      const launch = yield* prepareLaunch(config, request, binary);
      // A tool gate needs the turn's events, which need its thread, which only Codex names.
      let turn: CodexToolTurn | undefined;
      const server = yield* config
        .start(launch.command, {
          handlers: requestHandlers(config, binary, request.hubTools, () => turn),
          clientVersion: config.clientVersion,
        })
        .pipe(Effect.mapError(failed));
      // Before the thread opens, so Codex lists nothing to the model that Hobbots did not give it.
      const admitted = yield* admitSkills(server, launch.skills, launch.cwd);

      const tokens = yield* config.signIn(binary);
      if (tokens !== null) {
        yield* server
          .request("account/login/start", { type: "chatgptAuthTokens", ...tokens })
          .pipe(Effect.mapError(failed));
      }
      const opened = yield* openThread(server, request, launch.cwd, launch.instructions).pipe(Effect.mapError(failed));
      const threadId = opened.thread.id;
      const mapper = codexTurnEvents(
        threadId,
        skillRootsOf(launch.skills),
        admitted.organizationFiles,
        setSkillFilesOf(launch.skills, request.skills),
      );
      // The skill you picked loads with the turn's first input, as Codex's own skill item (ADR 029).
      const askedOne = askedMount(request.askedSkill, request.skills);
      const asked = askedSkillInput(launch.skills, askedOne);
      turn = {
        events: mapper,
        report,
        redact: request.redaction?.text ?? ((text) => text),
        tell: tellTurn(server, threadId),
        gate: launch.gate,
      };
      report({
        _tag: "SessionStarted",
        sessionId: threadId,
        billing: billingOf(tokens),
        ...launch.session,
        ...(admitted.organization.length > 0 ? { organizationSkills: admitted.organization } : {}),
      });
      yield* Deferred.await(accepted);

      // Subscribed before the turn starts, so its first notifications are not missed.
      const notifications = yield* server.subscribe;
      const signals = yield* Queue.unbounded<TurnSignal>();
      const now: CodexTurnNow = { turnId: null, ended: yield* Deferred.make<void>() };
      yield* Effect.forkScoped(follow(notifications, mapper, report, signals, now));

      // A follow-up turn about a command that outlived its turn carries text only.
      const startTurn = (text: string, skill: typeof asked = null) =>
        Effect.gen(function* () {
          mapper.expect();
          now.ended = yield* Deferred.make<void>();
          const started: TurnStartResponse = yield* server
            .request("turn/start", {
              threadId,
              input: [{ type: "text", text, text_elements: [] }, ...(skill === null ? [] : [skill])],
              ...TURN_SETTINGS,
              ...(request.model ? { model: request.model } : {}),
              ...(request.effort ? { effort: request.effort } : {}),
            })
            .pipe(Effect.mapError(failed));
          mapper.follow(started.turn.id);
          now.turnId = started.turn.id;
          // Codex took the skill item with the turn, so the skill you picked is used (ADR 029).
          if (skill !== null) {
            const set = askedOne?.set ? { set: askedOne.set.name } : {};
            report({ _tag: "SkillUsed", source: "library", name: skill.name, explicit: true, ...set });
          }
        });

      // Cancelling the turn asks Codex to stop it and waits for the acknowledgement, so the process
      // ends only once what it ran has stopped (ADR 024). It runs before the reader stops. While no
      // Codex turn runs, closing the App Server stops what is left.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (now.turnId === null) return;
          // One deadline covers the request and its acknowledgement, so a Codex that stops answering
          // still has its process ended.
          yield* server
            .request("turn/interrupt", { threadId, turnId: now.turnId })
            .pipe(
              Effect.ignore,
              Effect.andThen(Deferred.await(now.ended)),
              Effect.timeout(config.interruptGrace ?? "10 seconds"),
              Effect.ignore,
            );
        }),
      );

      yield* startTurn(turnPrompt(request, launch.instructions, launch.commits), asked);
      return yield* finish(yield* settle(signals, mapper, now, startTurn), mapper, report, Queue.end(queue));
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
