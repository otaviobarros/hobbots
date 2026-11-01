import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  type AccountInfo,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type ModelInfo,
  type Options,
  query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  operationDecision,
  type PromptRequest,
  type Redactor,
  RuntimeAdapter,
  RuntimeError,
  type RuntimeEvent,
  RuntimeLimitReached,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import {
  policySandbox,
  type RuntimeEnforcement,
  RuntimeHealth,
  RuntimeModel,
  RuntimeModels,
  type SandboxState,
  stableJson,
} from "@hobbots/domain";
import { type PolicyContext, PolicyEngine, type PolicyVerdict } from "@hobbots/permissions";
import { Clock, DateTime, Duration, Effect, Layer, Queue, Stream } from "effect";
import { type CallDecision, decideCall, refusal, type ToolCall, UNKNOWN_TOOL } from "./approval.ts";
import { CLAUDE_CODE_MODEL_HOSTS, ProcessSandbox } from "./sandbox.ts";
import { offeredTools, toolLabel } from "./tool-calls.ts";

export interface ClaudeCodeConfig {
  /** Empty working folder the runtime is confined to. */
  readonly workspaceDir: string;
  /** Claude Code binary to run instead of the one found on this machine. */
  readonly executable?: string | undefined;
  /** How long a health or model check waits for Claude Code to answer (30 seconds by default). */
  readonly checkTimeout?: Duration.Input | undefined;
}

/** Oldest Claude Code release verified with the locked Agent SDK; revisit when the SDK is upgraded. */
export const minimumClaudeCodeVersion = "2.1.301";

const installGuidance = "Install Claude Code from https://code.claude.com/docs/en/setup, then sign in with `claude`.";

// Where Claude Code's installers (native, local, Homebrew, npm) put it. An app opened from Finder
// gets a bare PATH, so these are searched before PATH and added to the runtime's own PATH.
const systemDirs: ReadonlyArray<string> = ["/opt/homebrew/bin", "/usr/local/bin"];
const installDirs = (home: string, system = systemDirs) => [
  join(home, ".local", "bin"),
  join(home, ".claude", "local"),
  ...system,
];

// Relative entries would resolve against the server's working folder.
const pathDirs = (env: NodeJS.ProcessEnv) => (env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));

/** Where to look for the host's Claude Code, in order (macOS and Linux). */
export const claudeCandidates = (env: NodeJS.ProcessEnv, home: string, system = systemDirs): ReadonlyArray<string> =>
  [...installDirs(home, system), ...pathDirs(env)].map((dir) => join(dir, "claude"));

/** PATH for Claude Code, so an npm install finds `node` even when the app was opened from Finder. */
export const runtimePath = (binary: string, env: NodeJS.ProcessEnv, home: string): string =>
  [...new Set([dirname(binary), ...installDirs(home), ...pathDirs(env)])].join(delimiter);

const runtimeEnv = (binary: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: runtimePath(binary, process.env, homedir()),
});

const execFileAsync = promisify(execFile);

/**
 * What a sandboxed turn is told about the sandbox, after the hob's own instructions: Git's config
 * and hooks in each repository are read-only (ADR 014), so Git's warning when it cannot write them
 * is expected, and the changes that need them are the user's to make.
 */
export const SANDBOX_NOTE = [
  "Your commands run in a sandbox. In every Git repository, .git/config and .git/hooks are read-only.",
  "Git prints `could not write config file .git/config: Operation not permitted` when it tries to change them, for example when deleting a branch; if the command otherwise succeeded, that warning is expected and not worth mentioning.",
  "A change that needs .git/config or a hook, such as adding a remote, setting an upstream or installing a hook, fails here: ask the user to make it.",
].join(" ");

/** The text appended to Claude Code's system prompt: the hob's instructions, and the sandbox note when sandboxed. */
export const turnInstructions = (instructions: string, sandboxed: boolean) =>
  sandboxed ? [instructions, SANDBOX_NOTE].filter((part) => part !== "").join("\n\n") : instructions;

/** The user's own Claude Code configuration folder, which the sandbox keeps closed. */
const userConfigFolder = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** The keychain item where Claude Code keeps a claude.ai login on macOS, for the default config folder. */
const KEYCHAIN_LOGIN = "Claude Code-credentials";
// Claude Code cannot refresh a login inside the sandbox, so the hub tries to before a turn when this
// close to expiry. Claude Code refreshes only an expired login, so a turn may still start with less.
const LOGIN_REFRESH_MS = 10 * 60_000;
// A turn never starts with a login that ends sooner than this.
const LOGIN_MINIMUM_MS = 60_000;

/** The access token and its expiry from Claude Code's keychain item, or null without a usable one. */
export const parseKeychainLogin = (secret: string): { readonly token: string; readonly expiresAt: number } | null => {
  try {
    const login = (JSON.parse(secret) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } })
      .claudeAiOauth;
    return typeof login?.accessToken === "string" && typeof login.expiresAt === "number"
      ? { token: login.accessToken, expiresAt: login.expiresAt }
      : null;
  } catch {
    return null;
  }
};

/**
 * The sign-in a sandboxed Claude Code turn gets in its environment (ADR 014). The sandbox has no
 * keychain access, since through it any command could read every credential a trusted helper such
 * as `git credential-osxkeychain` or `gh` can. A key or token in the hub's environment passes through
 * as it is; otherwise the hub reads the claude.ai login's short-lived access token, never the refresh
 * token, and asks Claude Code to refresh it first when it is close to expiry. A turn that outlives the token
 * fails with Claude Code's own sign-in error.
 */
const sandboxLogin = (binary: string): Effect.Effect<Record<string, string>, RuntimeError> =>
  Effect.gen(function* () {
    // A token from the hub's environment passes through as it is. An API key never does (ADR 009).
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return {};
    const read = Effect.promise(() =>
      (process.platform === "darwin"
        ? execFileAsync("security", ["find-generic-password", "-s", KEYCHAIN_LOGIN, "-w"], { timeout: 10_000 }).then(
            ({ stdout }) => stdout,
          )
        : readFile(join(userConfigFolder(), ".credentials.json"), "utf8")
      ).then(
        (secret) => parseKeychainLogin(secret.trim()),
        () => null,
      ),
    );
    let login = yield* read;
    if (login === null) return {};
    if (login.expiresAt - Date.now() < LOGIN_REFRESH_MS) {
      // Outside the sandbox Claude Code refreshes an expired login whenever it checks it.
      yield* Effect.promise(() =>
        execFileAsync(binary, ["auth", "status"], { timeout: 30_000, env: runtimeEnv(binary) }).catch(() => undefined),
      );
      login = yield* read;
    }
    if (login === null || login.expiresAt - Date.now() < LOGIN_MINIMUM_MS)
      return yield* new RuntimeError({
        message: "Claude Code's sign-in has expired. Open Claude Code to sign in again, then try again.",
      });
    return { CLAUDE_CODE_OAUTH_TOKEN: login.token };
  });

/**
 * Copies one transcript between configuration folders, run in its own process. It enters each
 * folder on the way and checks where it really landed, so a link anywhere on the path is refused,
 * and then reads and writes only by name inside the folder it holds. A command that swaps a folder
 * for a link meanwhile cannot redirect it: the folder it entered stays where it was checked.
 * Arguments: source root, target root, project, transcript file, then older projects to clear.
 */
const COPY_TRANSCRIPT = `
const fs = require("node:fs");
const { join } = require("node:path");
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const [source, target, project, file, ...older] = process.argv.slice(1);
const enter = (root, parts, create) => {
  process.chdir(root);
  let here = root;
  if (process.cwd() !== here) throw new Error("moved");
  for (const part of parts) {
    if (create) try { fs.mkdirSync(part, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    process.chdir(part);
    here = join(here, part);
    if (process.cwd() !== here) throw new Error("linked");
  }
};
enter(source, ["projects", project], false);
const from = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
if (!fs.fstatSync(from).isFile()) throw new Error("not a file");
const transcript = fs.readFileSync(from);
fs.closeSync(from);
for (const old of older) {
  try { enter(target, ["projects", old], false); fs.rmSync(file, { force: true }); } catch {}
}
enter(target, ["projects", project], true);
const partial = "." + file + ".partial";
fs.rmSync(partial, { force: true });
const to = fs.openSync(partial, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
fs.writeFileSync(to, transcript);
fs.closeSync(to);
fs.renameSync(partial, file);
`;

/**
 * Makes `target` hold the latest copy of a session, by copying its transcript in from whichever
 * configuration folder last wrote it. Claude Code keeps a session's id on resume and appends where
 * the turn ran, so a thread whose turns move between folders keeps its whole history this way. A
 * session no folder has is left for Claude Code to report. A hob's commands can write its runtime
 * folder, even while this runs, so the copy itself runs in COPY_TRANSCRIPT. Only the transcript
 * moves: what a session keeps beside it, such as subagent runs, stays where it was written.
 */
export const adoptSession = async (target: string, sources: ReadonlyArray<string>, sessionId: string) => {
  const file = `${sessionId}.jsonl`;
  const copiesIn = (folder: string) => {
    try {
      return readdirSync(join(folder, "projects")).flatMap((project) => {
        const transcript = lstatSync(join(folder, "projects", project, file), { throwIfNoEntry: false });
        return transcript?.isFile() ? [{ folder, project, written: transcript.mtimeMs }] : [];
      });
    } catch {
      return [];
    }
  };
  const held = copiesIn(target);
  const latest = [...held, ...sources.flatMap(copiesIn)].reduce<(typeof held)[number] | undefined>(
    (best, copy) => (best === undefined || copy.written > best.written ? copy : best),
    undefined,
  );
  if (latest === undefined || latest.folder === target) return;
  try {
    // An older copy left in another project folder would compete with the new one.
    const older = held.filter((copy) => copy.project !== latest.project).map((copy) => copy.project);
    // The folder itself is the hub's: commands cannot replace it, only what is inside.
    mkdirSync(target, { recursive: true, mode: 0o700 });
    await promisify(execFile)(
      process.execPath,
      [
        "-e",
        COPY_TRANSCRIPT,
        "--",
        realpathSync.native(latest.folder),
        realpathSync.native(target),
        latest.project,
        file,
        ...older,
      ],
      // Electron runs the script as Node does.
      { env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 },
    );
  } catch {
    // Claude Code reports a session it cannot resume.
  }
};

/** A bare binary name as the absolute path the runtime's PATH finds it at. */
const resolveBinary = (binary: string): Effect.Effect<string, RuntimeError> => {
  if (isAbsolute(binary)) return Effect.succeed(binary);
  const found = runtimePath(binary, process.env, homedir())
    .split(delimiter)
    .map((dir) => join(dir, binary))
    .find((path) => isAbsolute(path) && isExecutable(path));
  return found
    ? Effect.succeed(found)
    : Effect.fail(new RuntimeError({ message: `Could not find ${binary} on PATH, so the sandbox cannot start it.` }));
};

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The configured binary, or the first executable candidate on this machine. A relative path is
 * resolved here, because Claude Code is started from the workspace folder; a bare name stays a PATH lookup.
 */
export const findClaudeCode = (
  executable: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  system = systemDirs,
): string | undefined => {
  const configured = executable?.trim();
  if (configured) return configured.includes(sep) ? resolve(configured) : configured;
  return claudeCandidates(env, home, system).find(isExecutable);
};

/** The `major.minor.patch` that `claude --version` starts with. */
export const parseVersion = (output: string): string | undefined => /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1];

export const isAtLeast = (version: string, minimum: string): boolean => {
  const [a, b] = [version, minimum].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const diff = (a?.[i] ?? 0) - (b?.[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
};

/**
 * Reports where requests are billed, from the SDK's own credential fields.
 * Only a claude.ai login (no API key, a Pro/Max/Team plan) counts as the subscription.
 */
export const billingFrom = (apiKeySource: string | undefined, subscriptionType?: string): string => {
  if (apiKeySource !== undefined && apiKeySource !== "none") return `api-key (${apiKeySource})`;
  if (subscriptionType === undefined) return "subscription";
  if (subscriptionType === "Claude API") return "api (Claude API)";
  return `subscription (${subscriptionType})`;
};

/**
 * Whether Claude Code has no Anthropic credentials: no claude.ai login and no API key. Other providers
 * (Bedrock, Vertex, a gateway) authenticate outside Claude Code, so they never count as signed out.
 */
export const isSignedOut = (account: AccountInfo): boolean =>
  (account.apiProvider ?? "firstParty") === "firstParty" &&
  (account.apiKeySource ?? "none") === "none" &&
  account.email === undefined &&
  account.subscriptionType === undefined &&
  (account.tokenSource ?? "none") === "none";

// Chat-only unless the turn has tools (see `toolOptions`): no built-in tools, nothing auto-approved,
// no user/project settings or MCP servers loaded from disk.
// ANTHROPIC_API_KEY is removed so Claude Code always uses the claude.ai login (the subscription).
const baseOptions = (config: ClaudeCodeConfig, executable: string): Options => ({
  cwd: config.workspaceDir,
  pathToClaudeCodeExecutable: executable,
  env: {
    ...runtimeEnv(executable),
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_AGENT_SDK_CLIENT_APP: "hobbots",
  },
  tools: [],
  disallowedTools: ["*"],
  permissionMode: "dontAsk",
  settingSources: [],
});

const shutdownGrace = "10 seconds";

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void);
    child.once("exit", done);
    if (hasExited(child)) done();
    return Effect.sync(() => child.off("exit", done));
  });

const stderrTailLimit = 4096;

/**
 * Keeps the end of Claude Code's error output. `read` waits briefly for the output to close, since the
 * process can report its exit before its last lines arrive.
 */
export const stderrTail = (stderr: Readable, limit = stderrTailLimit) => {
  let tail = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-limit);
  });
  const closed = Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void);
    stderr.once("close", done);
    if (stderr.closed) done();
    return Effect.sync(() => stderr.off("close", done));
  });
  return {
    read: closed.pipe(
      Effect.timeoutOption("1 second"),
      Effect.map(() => tail.trim()),
    ),
  };
};

/** A failed turn's error, with what Claude Code wrote to stderr when the process itself failed. */
const withStderr = (error: RuntimeError | RuntimeLimitReached, child: ChildProcess | undefined, tail: string) =>
  error instanceof RuntimeError &&
  child &&
  tail !== "" &&
  ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null)
    ? new RuntimeError({ message: `${error.message}\n${tail}` })
    : error;

/** Waits until a Claude Code process has exited, killing it if it is still running after the grace period. */
export const exited = (child: ChildProcess, grace: Duration.Input = shutdownGrace) =>
  waitForExit(child).pipe(
    Effect.timeoutOrElse({
      duration: grace,
      orElse: () => Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(waitForExit(child))),
    }),
  );

/** Ends what a sandboxed turn left running, which would otherwise keep its rules after the turn. */
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already ended.
  }
};

/** The hob's brain for one turn; a null model or effort leaves Claude Code's own default. */
export const brainOptions = (request: Pick<PromptRequest, "model" | "effort">): Pick<Options, "model" | "effort"> => ({
  ...(request.model ? { model: request.model } : {}),
  ...(request.effort ? { effort: request.effort } : {}),
});

/**
 * Claude Code's model list in Hobbots' shape. A model without effort support takes no effort level.
 * Its aliases, such as "opus", are the main models; pinned ids such as "claude-opus-4-8" are older
 * versions kept for hobs that need them.
 */
export const toRuntimeModels = (infos: ReadonlyArray<ModelInfo>): RuntimeModels =>
  new RuntimeModels({
    runtime: "claude-code",
    source: "runtime",
    models: infos.map(
      (info) =>
        new RuntimeModel({
          id: info.value,
          displayName: info.displayName,
          description: info.description,
          efforts: info.supportsEffort ? (info.supportedEffortLevels ?? []) : [],
          main: !info.value.startsWith("claude-"),
        }),
    ),
  });

const allEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The model aliases Claude Code documents (https://code.claude.com/docs/en/model-config), offered
 * while the installed Claude Code cannot list its own models, such as before it is installed.
 * Claude Code lowers an effort a model does not support, so every level is offered.
 */
export const fallbackModels = new RuntimeModels({
  runtime: "claude-code",
  source: "fallback",
  models: [
    { id: "default", displayName: "Default", description: "Claude Code's recommended model for your account" },
    { id: "opus", displayName: "Opus", description: "Best for everyday, complex tasks" },
    { id: "fable", displayName: "Fable", description: "Most capable for your hardest and longest-running tasks" },
    { id: "sonnet", displayName: "Sonnet", description: "Efficient for routine tasks" },
    { id: "haiku", displayName: "Haiku", description: "Fastest for quick answers" },
  ].map((model) => new RuntimeModel({ ...model, efforts: allEfforts, main: true })),
});

/**
 * How long a model list is trusted: a reported list for five minutes, the fallback for one, so a
 * Claude Code that did not answer is asked again soon without being started on every request.
 */
export const modelListMaxAge = (models: RuntimeModels): Duration.Duration =>
  models.source === "runtime" ? Duration.minutes(5) : Duration.minutes(1);

/** Keeps each key's value until `maxAge` of that value has passed, then loads it again. */
export const expiringCache = <A>(maxAge: (value: A) => Duration.Duration) => {
  const entries = new Map<string, { readonly value: A; readonly expiresAt: number }>();
  return <E, R>(key: string, load: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const entry = entries.get(key);
      if (entry !== undefined && now < entry.expiresAt) return entry.value;
      const value = yield* load;
      entries.set(key, { value, expiresAt: now + Duration.toMillis(maxAge(value)) });
      return value;
    });
};

/** The rate limit refused the turn and no paid overage covers it. */
const limitReached = (info: SDKRateLimitInfo) =>
  info.status === "rejected" && info.overageStatus !== "allowed" && info.overageStatus !== "allowed_warning";

/**
 * Maps one turn's SDK messages to runtime events. Stateful, so make one per turn: a thinking block
 * becomes a step that starts with the block and ends when it stops.
 */
export const turnEvents = () => {
  // The step of each open thinking block, by content block index.
  const open = new Map<number, string>();
  let steps = 0;
  const endAll = (): ReadonlyArray<RuntimeEvent> => {
    const ended = Array.from(open.values(), (id): RuntimeEvent => ({ _tag: "StepEnded", id }));
    open.clear();
    return ended;
  };

  // complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
  return (message: SDKMessage): ReadonlyArray<RuntimeEvent> => {
    switch (message.type) {
      case "system":
        return message.subtype === "init"
          ? [
              {
                _tag: "SessionStarted",
                sessionId: message.session_id,
                billing: billingFrom(message.apiKeySource),
              },
            ]
          : [];
      case "stream_event": {
        const event = message.event;
        // Subagents' own output stays out of the hob's reply.
        if (message.parent_tool_use_id !== null) return [];
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block.type;
            if (block !== "thinking" && block !== "redacted_thinking") return [];
            steps += 1;
            const id = `thinking-${steps}`;
            open.set(event.index, id);
            return [{ _tag: "StepStarted", id, kind: "thinking", label: "Thinking" }];
          }
          case "content_block_stop": {
            const id = open.get(event.index);
            if (id === undefined) return [];
            open.delete(event.index);
            return [{ _tag: "StepEnded", id }];
          }
          case "content_block_delta":
            return event.delta.type === "text_delta" ? [{ _tag: "TextDelta", text: event.delta.text }] : [];
          // Block indexes start again with each message.
          case "message_stop":
            return endAll();
          default:
            return [];
        }
      }
      case "rate_limit_event":
        if (!limitReached(message.rate_limit_info)) return [];
        throw new RuntimeLimitReached({
          resetsAt:
            message.rate_limit_info.resetsAt === undefined
              ? null
              : new Date(message.rate_limit_info.resetsAt * 1000).toISOString(),
        });
      case "result":
        if (message.subtype !== "success" || message.is_error) {
          throw new RuntimeError({
            message: message.subtype === "success" ? message.result : `Claude Code turn ended: ${message.subtype}`,
          });
        }
        return [
          ...endAll(),
          {
            _tag: "Completed",
            sessionId: message.session_id,
            text: message.result,
          },
        ];
      default:
        return [];
    }
  };
};

/**
 * The prompt Claude Code receives. On resume Claude Code keeps the system prompt the session started
 * with, so instructions it may not follow come first in the turn itself. The block may repeat on
 * later turns, so it states the current instructions rather than announcing a change.
 */
export const turnPrompt = (
  request: Pick<PromptRequest, "prompt" | "sessionId" | "instructions" | "instructionsChanged">,
) =>
  request.sessionId && request.instructionsChanged
    ? [
        "<current-instructions>",
        "These are your current instructions. Follow them in place of the ones in your system prompt and any earlier ones:",
        "",
        request.instructions,
        "</current-instructions>",
        "",
        request.prompt,
      ].join("\n")
    : request.prompt;

/** A turn with tools: the context every call is decided under, its folders and the tools offered. */
export interface ToolTurn {
  readonly context: PolicyContext;
  /** Canonical and existing; the first is where Claude Code starts. */
  readonly folders: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  /** Claude Code's configuration folder for this hob. */
  readonly runtimeFolder: string;
}

/**
 * The turn's tools, or null for a chat-only turn: no access, no folder that exists, reading the
 * folders denied (Claude Code cannot start in a folder it cannot read), or no tool open.
 */
export const toolTurn = (access: ToolAccess | null | undefined, sandbox: SandboxState): ToolTurn | null => {
  if (!access) return null;
  const folders = [
    ...new Set(
      access.folders.flatMap((folder) => {
        try {
          return [realpathSync(folder)];
        } catch {
          return [];
        }
      }),
    ),
  ];
  if (folders.length === 0) return null;
  const context: PolicyContext = { ...access.policy, sandbox, modelHosts: CLAUDE_CODE_MODEL_HOSTS };
  if (operationDecision(context, "read-files") === "deny") return null;
  const tools = offeredTools(context);
  return tools.length === 0 ? null : { context, folders, tools, runtimeFolder: access.runtimeFolder };
};

/**
 * The hooks that put every tool call before the policy engine (ADR 014). PreToolUse decides the
 * call and reports it; a call that is not allowed never runs, whatever the prompt says. A call the
 * policy answers Ask for goes on to the permission callback, which asks the user through
 * `approvals` and waits for the decision (PE-003); without `approvals` it is refused. The callback
 * also decides any call that reaches it without the hook's answer.
 */
export const policyHooks = (
  engine: PolicyEngine["Service"],
  turn: ToolTurn,
  report: (event: RuntimeEvent) => void,
  approvals?: TurnApprovals | null,
  redaction?: Redactor | null,
): { readonly hooks: NonNullable<Options["hooks"]>; readonly canUseTool: CanUseTool } => {
  const label = (tool: string, input: Record<string, unknown>) => toolLabel(tool, input, redaction?.text);
  const started = new Set<string>();
  // Each call as the hook saw it, so the permission callback decides the same call in the same folder.
  const seen = new Map<string, ToolCall>();
  const begin = (id: string, tool: string, input: Record<string, unknown>, verdict: PolicyVerdict) => {
    started.add(id);
    report({
      _tag: "ToolStarted",
      id,
      tool,
      operation: verdict.operation,
      targets: verdict.targets,
      label: label(tool, input),
    });
  };
  const refuse = (id: string, tool: string, input: Record<string, unknown>, decision: CallDecision) => {
    const reason = decision._tag === "Refuse" ? decision.reason : "";
    report({
      _tag: "ToolDenied",
      id,
      tool,
      // An unknown tool is refused as anything outside what the hob may do.
      operation: decision.verdict?.operation ?? "outside-folders",
      targets: decision.verdict?.targets ?? [],
      label: label(tool, input),
      reason,
      decidedBy: decision._tag === "Refuse" && decision.decidedBy === "user" ? "user" : "policy",
    });
    return reason;
  };
  const failed = (tool: string): CallDecision => ({ _tag: "Refuse", verdict: undefined, reason: UNKNOWN_TOOL(tool) });

  const preToolUse: HookCallback = async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const call = { id: input.tool_use_id, tool, input: toolInput, cwd: input.cwd || (turn.folders[0] as string) };
    // Only the policy decides here; asking the user waits in the permission callback.
    const decision = await Effect.runPromise(decideCall(engine, turn.context, null, call, report, redaction)).catch(
      () => failed(tool),
    );
    if (decision._tag === "Run") {
      begin(call.id, tool, toolInput, decision.verdict);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: decision.verdict.reason.message,
        },
      };
    }
    if (approvals && decision.verdict?.decision === "ask") {
      seen.set(call.id, call);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: decision.verdict.reason.message,
        },
      };
    }
    const reason = refuse(call.id, tool, toolInput, decision);
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };

  const finished =
    (failed: boolean): HookCallback =>
    async (input) => {
      if (
        (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") &&
        started.delete(input.tool_use_id)
      ) {
        report({ _tag: "ToolFinished", id: input.tool_use_id, failed });
      }
      return {};
    };

  const canUseTool: CanUseTool = async (tool, input, options) => {
    const hooked = seen.get(options.toolUseID);
    seen.delete(options.toolUseID);
    // A call the hook decided on other arguments is not the one it saw, so it does not run.
    if (hooked !== undefined && (hooked.tool !== tool || stableJson(hooked.input) !== stableJson(input))) {
      const reason = "The call changed after Hobbots decided it, so it did not run.";
      return {
        behavior: "deny",
        message: refuse(options.toolUseID, tool, input, { _tag: "Refuse", verdict: undefined, reason }),
      };
    }
    const call = { id: options.toolUseID, tool, input, cwd: hooked?.cwd ?? (turn.folders[0] as string) };
    // An aborted call stops waiting, which expires its request.
    const decision = await Effect.runPromise(decideCall(engine, turn.context, approvals, call, report, redaction), {
      signal: options.signal,
    }).catch(() => failed(tool));
    if (decision._tag === "Run") {
      // A call the hook allowed was reported then.
      if (!started.has(call.id)) begin(call.id, tool, input, decision.verdict);
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: refuse(call.id, tool, input, decision) };
  };

  return {
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [finished(false)] }],
      PostToolUseFailure: [{ hooks: [finished(true)] }],
    },
    canUseTool,
  };
};

/**
 * Claude Code's options for a turn with tools: only the offered built-in tools, started in the hob's
 * first folder with the others added, and every call decided by the hooks. Nothing is loaded from
 * settings or MCP configuration on disk, and no traffic beyond the model API is sent.
 */
export const toolOptions = (
  turn: ToolTurn,
  policy: ReturnType<typeof policyHooks>,
  env: Options["env"],
): Partial<Options> => ({
  cwd: turn.folders[0] as string,
  env: { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  additionalDirectories: turn.folders.slice(1),
  tools: [...turn.tools],
  disallowedTools: [],
  permissionMode: "default",
  strictMcpConfig: true,
  hooks: policy.hooks,
  canUseTool: policy.canUseTool,
});

const errorMessage = (error: unknown) =>
  error instanceof RuntimeError || error instanceof RuntimeLimitReached
    ? error
    : new RuntimeError({
        message: error instanceof Error ? error.message : String(error),
      });

export const makeClaudeCode = (config: ClaudeCodeConfig) =>
  Effect.gen(function* () {
    const engine = yield* PolicyEngine;
    const sandbox = yield* ProcessSandbox;
    yield* Effect.sync(() => mkdirSync(config.workspaceDir, { recursive: true }));

    // `claude --version` per binary, rerun when the file changes (as `claude update` does).
    const versions = new Map<string, { readonly modified: number; readonly version: string }>();
    const versionOf = (binary: string) =>
      Effect.gen(function* () {
        // A configured path may not exist, and an update can remove the binary between lookups.
        const modified = yield* Effect.try(() => statSync(binary).mtimeMs).pipe(Effect.orElseSucceed(() => -1));
        const cached = versions.get(binary);
        if (cached !== undefined && cached.modified === modified) return cached.version;
        const output = yield* Effect.tryPromise(() =>
          execFileAsync(binary, ["--version"], { timeout: 10_000, env: runtimeEnv(binary) }).then(
            (result) => result.stdout,
          ),
        ).pipe(Effect.orElseSucceed(() => ""));
        const version = parseVersion(output);
        if (version !== undefined) versions.set(binary, { modified, version });
        return version;
      });

    // Looked up on every use, so installing, moving or updating Claude Code needs no restart.
    const locate = Effect.gen(function* () {
      const binary = findClaudeCode(config.executable);
      if (binary === undefined) return { _tag: "Missing" } as const;
      const version = yield* versionOf(binary);
      if (version === undefined) return { _tag: "Broken", binary } as const;
      if (!isAtLeast(version, minimumClaudeCodeVersion)) return { _tag: "Outdated", binary, version } as const;
      return { _tag: "Found", binary, version } as const;
    });

    const notStarted = `Claude Code could not be started. ${installGuidance}`;
    const signedOut =
      "Claude Code is not signed in. Run `claude` in a terminal and sign in with your claude.ai account.";
    const outdated = `Hobbots needs Claude Code ${minimumClaudeCodeVersion} or later. Run \`claude update\`.`;

    const executable = Effect.gen(function* () {
      const located = yield* locate;
      switch (located._tag) {
        case "Found":
          return located.binary;
        case "Missing":
          return yield* new RuntimeError({ message: `Claude Code was not found. ${installGuidance}` });
        case "Broken":
          return yield* new RuntimeError({ message: notStarted });
        case "Outdated":
          return yield* new RuntimeError({ message: `Claude Code ${located.version} is too old. ${outdated}` });
      }
    });

    const sandboxed = sandbox.state === "on";
    const declared: RuntimeEnforcement = {
      toolInterception: {
        status: "verified",
        evidence:
          "Every built-in tool call passes the PreToolUse hook; settings and MCP servers on disk are not loaded.",
      },
      processSandbox: !sandboxed
        ? { status: "unsupported", evidence: sandbox.evidence }
        : process.platform === "darwin"
          ? { status: "verified", evidence: `Claude Code starts inside ${sandbox.evidence}.` }
          : {
              status: "unverified",
              evidence: `Claude Code starts inside ${sandbox.evidence}, not yet verified on this platform.`,
            },
      hubTools: { status: "unsupported", evidence: "Charms and coordination tools are not served yet." },
      toolEvents: {
        status: "verified",
        evidence: "PreToolUse, PostToolUse and PostToolUseFailure hooks report each call.",
      },
      toolInterruption: {
        status: "verified",
        evidence: "Cancelling the turn aborts Claude Code and waits for it to exit.",
      },
    };

    const sendPrompt = (request: PromptRequest) =>
      Stream.callback<RuntimeEvent, RuntimeError | RuntimeLimitReached>((queue) =>
        Effect.gen(function* () {
          const binary = yield* executable;
          // Tools are decided as if the sandbox were missing until it is verified here (ADR 014), but a
          // sandbox that starts still wraps the runtime.
          const tools = toolTurn(request.tools, policySandbox(declared));
          const sandboxed = tools !== null && sandbox.state === "on";
          // The sandbox opens the binary's folder, so it must be a real path, never the hub's own folder.
          const absoluteBinary = sandboxed ? yield* resolveBinary(binary) : binary;
          const login = sandboxed ? yield* sandboxLogin(binary) : {};
          // The sign-in sits in the tools' environment, where any command can print it.
          for (const value of Object.values(login)) request.redaction?.remember({ value, kind: "Claude sign-in" });
          // A sandboxed turn keeps its sessions in the hob's runtime folder, and one without tools in the
          // user's own, so a thread resumes wherever its last turn ran.
          const { sessionId } = request;
          if (sessionId && request.tools) {
            const [target, source] = sandboxed
              ? [tools.runtimeFolder, userConfigFolder()]
              : [userConfigFolder(), request.tools.runtimeFolder];
            yield* Effect.promise(() => adoptSession(target, [source], sessionId));
          }
          const prepared = sandboxed
            ? yield* Effect.acquireRelease(
                sandbox.prepare({
                  folders: tools.folders,
                  // What any call the policy lets through may need; a denied operation stays closed.
                  folderAccess: {
                    read: operationDecision(tools.context, "read-files") !== "deny",
                    write: operationDecision(tools.context, "edit-files") !== "deny",
                  },
                  dataFolder: tools.context.dataFolder,
                  binary: absoluteBinary,
                  runtimeFolder: tools.runtimeFolder,
                  allowedHosts: CLAUDE_CODE_MODEL_HOSTS,
                  decideHost: (host) =>
                    Effect.runPromise(
                      engine
                        .decide(tools.context, { _tag: "Web", host, addresses: [] })
                        .pipe(Effect.map((verdict) => (verdict.decision === "allow" ? true : refusal(verdict)))),
                    ),
                }),
                (prepared) => Effect.sync(prepared.release),
              )
            : null;
          const base = baseOptions(config, binary);
          const abortController = new AbortController();
          // Hobbots starts the process itself so it can tell when it has really exited.
          let child: ChildProcess | undefined;
          let stderr: ReturnType<typeof stderrTail> | undefined;
          const spawnClaudeCodeProcess = (options: SpawnOptions) => {
            const { command, args, env } = prepared
              ? prepared.spawnArgs(options.command, options.args, { ...options.env, ...login })
              : options;
            const spawned = spawn(command, args, {
              cwd: options.cwd,
              env,
              signal: options.signal,
              // Its own process group, so what its commands leave running ends with the turn.
              detached: prepared !== null,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
            child = spawned;
            stderr = stderrTail(spawned.stderr);
            return spawned;
          };
          const turn = yield* Effect.acquireRelease(
            Effect.sync(() =>
              query({
                prompt: turnPrompt(request),
                options: {
                  ...base,
                  ...(tools
                    ? toolOptions(
                        tools,
                        policyHooks(
                          engine,
                          tools,
                          (event) => Queue.offerUnsafe(queue, event),
                          request.approvals,
                          request.redaction,
                        ),
                        base.env,
                      )
                    : {}),
                  abortController,
                  spawnClaudeCodeProcess,
                  includePartialMessages: true,
                  systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    append: turnInstructions(request.instructions, sandboxed),
                  },
                  ...(request.sessionId ? { resume: request.sessionId } : {}),
                  ...brainOptions(request),
                },
              }),
            ),
            // A cancelled turn has ended only once Claude Code has exited: close() starts the shutdown
            // without waiting for it. A process that outlives the grace period is killed.
            (turn) =>
              Effect.sync(() => {
                abortController.abort();
                turn.close();
              }).pipe(
                Effect.andThen(child ? exited(child) : Effect.void),
                Effect.andThen(Effect.sync(() => prepared && child?.pid && killGroup(child.pid))),
              ),
          );
          const toEvents = turnEvents();
          // Tool events arrive from the hooks while the turn runs, so the turn's own events share their queue.
          yield* Stream.fromAsyncIterable(turn, errorMessage).pipe(
            Stream.mapEffect((message) => Effect.try({ try: () => toEvents(message), catch: errorMessage })),
            Stream.flattenIterable,
            Stream.catch((error) =>
              Stream.unwrap(
                (stderr ? stderr.read : Effect.succeed("")).pipe(
                  Effect.map((tail) => Stream.fail(withStderr(error, child, tail))),
                ),
              ),
            ),
            Stream.runForEach((event) => Queue.offer(queue, event)),
          );
          yield* Queue.end(queue);
        }),
      );

    const runtimeHealth = (fields: Pick<RuntimeHealth, "availability" | "version" | "detail" | "checkedAt">) =>
      new RuntimeHealth({ runtime: "claude-code", billing: null, enforcement: declared, ...fields });

    const checkTimeout = config.checkTimeout ?? "30 seconds";

    // Starts Claude Code without sending a prompt, so asking it something costs no usage. The
    // session belongs to a scope, so a check that times out or is interrupted still closes it.
    const askIdleSession = <A>(binary: string, ask: (session: ReturnType<typeof query>) => Promise<A>) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const idle: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise(() => {}),
            }),
          };
          return query({ prompt: idle, options: baseOptions(config, binary) });
        }),
        (session) => Effect.sync(() => session.close()),
      ).pipe(
        Effect.flatMap((session) => Effect.tryPromise({ try: () => ask(session), catch: errorMessage })),
        Effect.timeout(checkTimeout),
        Effect.scoped,
      );

    const probe = (binary: string, version: string, checkedAt: string) =>
      askIdleSession(binary, async (session) => {
        const account = await session.accountInfo();
        if (isSignedOut(account)) {
          return runtimeHealth({ availability: "signedOut", version, detail: signedOut, checkedAt });
        }
        return new RuntimeHealth({
          runtime: "claude-code",
          availability: "ready",
          billing: billingFrom(account.apiKeySource, account.subscriptionType),
          version,
          detail: account.email ?? null,
          checkedAt,
          enforcement: declared,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            runtimeHealth({
              availability: "unavailable",
              version,
              detail: "message" in error ? String(error.message) : "Claude Code did not respond",
              checkedAt,
            }),
          ),
        ),
      );

    // Finds the host's Claude Code and checks its version before starting it.
    const health = Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const located = yield* locate;
      switch (located._tag) {
        case "Missing":
          return runtimeHealth({ availability: "unavailable", version: null, detail: installGuidance, checkedAt });
        case "Broken":
          return runtimeHealth({
            availability: "unavailable",
            version: null,
            detail: `${located.binary} did not report a Claude Code version. ${notStarted}`,
            checkedAt,
          });
        case "Outdated":
          return runtimeHealth({ availability: "outdated", version: located.version, detail: outdated, checkedAt });
        case "Found":
          return yield* probe(located.binary, located.version, checkedAt);
      }
    });

    // Starting Claude Code takes seconds, so each binary's list is kept for a while. The account or a
    // managed model policy can change it without a new binary, so it is fetched again when it expires.
    const modelCache = expiringCache(modelListMaxAge);
    const models = Effect.gen(function* () {
      const located = yield* locate;
      if (located._tag !== "Found") return fallbackModels;
      return yield* modelCache(
        `${located.binary}@${located.version}`,
        askIdleSession(located.binary, (session) => session.supportedModels()).pipe(
          Effect.map((listed) => (listed.length === 0 ? fallbackModels : toRuntimeModels(listed))),
          Effect.orElseSucceed(() => fallbackModels),
        ),
      );
    });

    return RuntimeAdapter.of({ health, models, enforcement: Effect.succeed(declared), sendPrompt });
  });

/** Claude Code with tools under the hub's policy engine and process sandbox. */
export const ClaudeCodeLayer = (config: ClaudeCodeConfig) => Layer.effect(RuntimeAdapter, makeClaudeCode(config));
