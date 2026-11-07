import { type ChildProcess, execFile, spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
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
  type SDKResultSuccess,
  type SDKUsageReport,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  approvalNote,
  type HubTools,
  operationDecision,
  type PromptRequest,
  type Redactor,
  RuntimeAdapter,
  RuntimeError,
  type RuntimeEvent,
  RuntimeLimitReached,
  type ToolAccess,
  type TurnApprovals,
  UNRECORDED_TOOL_CALL,
} from "@hobbots/agents";
import {
  type CommitIdentity,
  type CommitsAs,
  GIT_INIT_TOOL,
  type PlanUsage,
  policySandbox,
  type ReplyUsage,
  type RuntimeEnforcement,
  RuntimeHealth,
  RuntimeModel,
  RuntimeModels,
  type SandboxState,
  stableJson,
  unreportedPlan,
} from "@hobbots/domain";
import {
  type PolicyContext,
  PolicyEngine,
  type PolicyVerdict,
  policyVersion,
  type RuntimeOutput,
} from "@hobbots/permissions";
import { type Duration, Effect, Layer, Queue, Stream } from "effect";
import {
  type CallDecision,
  decideCall,
  grantedHosts,
  keptGitHint,
  startCall,
  type ToolCall,
  UNKNOWN_TOOL,
} from "./approval.ts";
import { type BackgroundCommands, backgroundCommands, isTaskEnd } from "./background-commands.ts";
import {
  binaryLocator,
  findBinary,
  installedPlanUsage,
  installedRuntimeChecks,
  isExecutable,
  runnableBinary,
} from "./binary.ts";
import { askedSkillPrompt, READ_TOOL, readsSkillFile, SKILL_TOOL, withSkills } from "./claude-code-skills.ts";
import { COMMAND_ENV_FILE_VARIABLE, commandColorFile, plainBashResponse } from "./command-color.ts";
import { toolFinished } from "./command-exit.ts";
import { turnCommits } from "./git-config.ts";
import { hubToolOf, withHubTools } from "./hub-tools.ts";
import {
  CLAUDE_CODE_MODEL_HOSTS,
  folderAccessFor,
  onePasswordAgentSocket,
  ProcessSandbox,
  TEMP_NOTE,
  withCommitIdentity,
} from "./sandbox.ts";
import { askedMount, holdSkillFolder, skillFolderScope } from "./skills.ts";
import { commandOf, offeredTools, toolLabel } from "./tool-calls.ts";
import { fullToolOutput, savedOutputFolder } from "./tool-output.ts";

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
 * is expected, the hub creates a new repository, and the other changes that need them are the
 * user's to make. Temporary files go in the turn's own folder, `TMPDIR` (#578).
 */
export const SANDBOX_NOTE = [
  "Your commands run in a sandbox. In every Git repository, .git/config and .git/hooks are read-only.",
  "Git prints `could not write config file .git/config: Operation not permitted` when it tries to change them, for example when deleting a branch; if the command otherwise succeeded, that warning is expected and not worth mentioning.",
  "To create a repository, use the git_init tool instead of git init, which cannot write a new repository's config here; it also replaces the .git/config and .git/hooks a deleted repository leaves behind.",
  "Any other change that needs .git/config or a hook, such as adding a remote, setting an upstream or installing a hook, fails here: ask the user to make it.",
  TEMP_NOTE,
].join(" ");

/**
 * What a turn that can ask the user is told about approvals: the hob never sees the request, so the
 * note on a tool result is its only record that it asked (#282).
 */
export const APPROVAL_NOTE = [
  "Some of your tool calls wait for the user to approve them. The user sees the approval request; you do not.",
  "When the user approved a call, its result ends with a note that says so and for how long. When they deny one, the result says it did not run and gives their reason if they wrote one.",
  "A result without such a note needed no approval. Go by these notes when you tell the user what you asked; never guess whether a request appeared.",
].join(" ");

/**
 * What a hob with its own GitHub App is told about its commits (ADR 022): it commits as its bot,
 * unsigned, and GitHub signs them when the hub pushes them. Without it, a hob that reads the user's
 * signing setup asks Git for a signature that only the user's key could make.
 */
export const botCommitNote = (commitAs: CommitIdentity) =>
  [
    `Your commits are made as ${commitAs.name} <${commitAs.email}>, the bot of your own GitHub App, and are unsigned here: never pass -S or turn signing on.`,
    "When your commits are pushed, GitHub recreates them as your bot and signs them, so they show as Verified on GitHub. A local commit shows no signature until then; that is expected.",
  ].join(" ");

/**
 * The text appended to Claude Code's system prompt: the hob's instructions, the approval note when
 * the turn can ask the user, the sandbox note when sandboxed, and the bot note when the hob commits
 * as its own app.
 */
export const turnInstructions = (
  instructions: string,
  sandboxed: boolean,
  asks = false,
  commitAs?: CommitIdentity,
  identityNote = "",
) =>
  [
    instructions,
    asks ? APPROVAL_NOTE : "",
    sandboxed ? SANDBOX_NOTE : "",
    commitAs ? botCommitNote(commitAs) : "",
    identityNote,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

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

/**
 * The configured binary, or the first executable candidate on this machine. A relative path is
 * resolved here, because Claude Code is started from the workspace folder; a bare name stays a PATH lookup.
 */
export const findClaudeCode = (
  executable: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  system = systemDirs,
): string | undefined => findBinary(executable, () => claudeCandidates(env, home, system));

/** The `major.minor.patch` that `claude --version` starts with. */
export const parseVersion = (output: string): string | undefined => /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1];

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

/**
 * Settings every turn gets in place of the user's own, which are not loaded: no Claude attribution
 * on a hob's commits or pull requests. A hob's commits are its own or the user's, and Claude Code's
 * default `Co-Authored-By` trailer would name Claude on every one.
 *
 * Nothing a claude.ai sign-in brings reaches a hob either (ADR 029): no claude.ai connectors and no
 * skills or plugins synced from claude.ai. Claude Code's bundled skills are off, and a skill's text
 * never runs shell commands as it loads, which would bypass the policy hook.
 */
export const RUNTIME_SETTINGS = {
  attribution: false,
  disableClaudeAiConnectors: true,
  syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false,
  disableBundledSkills: true,
  disableSkillShellExecution: true,
} as const;

// Chat-only unless the turn has tools (see `toolOptions`): no built-in tools, nothing auto-approved,
// no user/project settings or MCP servers loaded from disk.
// ANTHROPIC_API_KEY is removed so Claude Code always uses the claude.ai login (the subscription).
export const baseOptions = (config: ClaudeCodeConfig, executable: string): Options => ({
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
  // Only the MCP servers Hobbots passes, on every turn, chat-only turns included (ADR 029).
  strictMcpConfig: true,
  // The turn's skills, if any, are added with `withSkills`; none is listed until then.
  skills: [],
  settings: RUNTIME_SETTINGS,
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
 * Claude Code's alias for its fastest model, documented as "Fastest for quick answers"
 * (https://code.claude.com/docs/en/model-config): what light work, such as memory's, runs on.
 */
const SMALL_ALIAS = "haiku";

/**
 * Claude Code's model list in Hobbots' shape. A model without effort support takes no effort level.
 * Its aliases, such as "opus", are the main models; pinned ids such as "claude-opus-4-8" are older
 * versions kept for hobs that need them.
 */
export const toRuntimeModels = (infos: ReadonlyArray<ModelInfo>): RuntimeModels =>
  new RuntimeModels({
    runtime: "claude-code",
    source: "runtime",
    ...(infos.some((info) => info.value === SMALL_ALIAS) ? { small: SMALL_ALIAS } : {}),
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
  small: SMALL_ALIAS,
  models: [
    { id: "default", displayName: "Default", description: "Claude Code's recommended model for your account" },
    { id: "opus", displayName: "Opus", description: "Best for everyday, complex tasks" },
    { id: "fable", displayName: "Fable", description: "Most capable for your hardest and longest-running tasks" },
    { id: "sonnet", displayName: "Sonnet", description: "Efficient for routine tasks" },
    { id: "haiku", displayName: "Haiku", description: "Fastest for quick answers" },
  ].map((model) => new RuntimeModel({ ...model, efforts: allEfforts, main: true })),
});

/** The rate limit refused the turn and no paid overage covers it. */
const limitReached = (info: SDKRateLimitInfo) =>
  info.status === "rejected" && info.overageStatus !== "allowed" && info.overageStatus !== "allowed_warning";

/**
 * What a turn took and used, from its result (https://code.claude.com/docs/en/agent-sdk/typescript).
 * `usage` is this turn's main loop alone. `modelUsage` is left out: it adds subagents but runs on
 * across a resumed session's turns. A timing an older Claude Code does not report is null.
 */
export const turnUsage = (result: SDKResultSuccess): ReplyUsage => ({
  timeToRequestMs: result.time_to_request_ms ?? null,
  timeToFirstStreamMs: result.ttft_stream_ms ?? null,
  timeToFirstTokenMs: result.ttft_ms ?? null,
  inputTokens: result.usage.input_tokens,
  outputTokens: result.usage.output_tokens,
  cacheReadTokens: result.usage.cache_read_input_tokens,
  cacheWriteTokens: result.usage.cache_creation_input_tokens,
});

/**
 * A plan's meters from Claude Code's `/usage` report, as the server sent them
 * (https://code.claude.com/docs/en/agent-sdk/typescript#sdkusagereport). An API-key session or a token
 * without the profile scope gets no report, and a failed fetch no rows: neither reports any meter.
 */
export const planFromReport = (report: SDKUsageReport | undefined, checkedAt: string): PlanUsage => {
  const rates = report?.rate_limits;
  if (!rates) return unreportedPlan("claude-code", checkedAt);
  const extra = rates.extra_usage;
  return {
    runtime: "claude-code",
    // Rows can be missing while usage credits are still reported, and spend shows either way.
    reported: rates.limits !== null,
    checkedAt,
    meters: (rates.limits ?? []).map((row) => ({
      kind: row.kind,
      group: row.group,
      percent: row.percent,
      resetsAt: row.resets_at,
      scope: row.scope?.model?.display_name ?? row.scope?.surface?.display_name ?? null,
      severity: row.severity,
      active: row.is_active,
    })),
    extraUsage: extra
      ? {
          enabled: extra.is_enabled,
          monthlyLimit: extra.monthly_limit,
          usedCredits: extra.used_credits,
          currency: extra.currency ?? null,
        }
      : null,
  };
};

/**
 * Maps one turn's SDK messages to runtime events. Stateful, so make one per turn: a thinking block
 * becomes a step that starts with the block and ends when it stops. `tools` are the turn's, whose
 * policy version its session start reports.
 */
export const turnEvents = (tools: ToolTurn | null = null) => {
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
                ...sessionPolicy(tools),
              },
            ]
          : message.subtype === "compact_boundary"
            ? [{ _tag: "SessionCompacted" }]
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
            usage: turnUsage(message),
          },
        ];
      default:
        return [];
    }
  };
};

/** A count two runs of one turn both used: their sum, or whichever reported one when only one did. */
const summed = (earlier: number | null, later: number | null) =>
  earlier === null ? later : later === null ? earlier : earlier + later;

/**
 * What every run of one turn used: the tokens of each run added up (#1011). The timings say how the
 * turn got going, so they stay the first run's, and a run that reported none adds nothing.
 */
export const wholeUsage = (earlier: ReplyUsage | undefined, later: ReplyUsage | undefined): ReplyUsage | undefined =>
  earlier === undefined || later === undefined
    ? (earlier ?? later)
    : {
        ...earlier,
        inputTokens: summed(earlier.inputTokens, later.inputTokens),
        outputTokens: summed(earlier.outputTokens, later.outputTokens),
        cacheReadTokens: summed(earlier.cacheReadTokens, later.cacheReadTokens),
        cacheWriteTokens: summed(earlier.cacheWriteTokens, later.cacheWriteTokens),
      };

/**
 * One turn as the hub sees it, however many runs Claude Code makes of it. A background command that
 * finishes wakes the session after it replied: Claude Code starts another run in the same process,
 * announced as `init` again, with its own `result`. So the session starts once, and the turn
 * completes when Claude Code stops, with what each run replied and what all of them used.
 */
export const wholeTurn = (asked: string | null = null, askedSet: string | null = null) => {
  let started = false;
  let completed: Extract<RuntimeEvent, { _tag: "Completed" }> | null = null;
  return {
    read: (event: RuntimeEvent): ReadonlyArray<RuntimeEvent> => {
      if (event._tag === "SessionStarted") {
        if (started) return [];
        started = true;
        // The skill you picked loads with the prompt, as Claude Code's own mention (ADR 029).
        if (asked !== null) {
          const set = askedSet === null ? {} : { set: askedSet };
          return [event, { _tag: "SkillUsed", source: "library", name: asked, explicit: true, ...set }];
        }
      }
      if (event._tag !== "Completed") return [event];
      const earlier = completed?.text ?? "";
      const text = earlier !== "" && event.text !== "" ? `${earlier}\n\n${event.text}` : earlier + event.text;
      const usage = wholeUsage(completed?.usage, event.usage);
      // With no usage from either run, `event` has none to carry over.
      completed = usage === undefined ? { ...event, text } : { ...event, text, usage };
      return [];
    },
    end: (): ReadonlyArray<RuntimeEvent> => (completed === null ? [] : [completed]),
  };
};

/**
 * The prompt Claude Code receives. On resume Claude Code keeps the system prompt the session started
 * with, so instructions it may not follow come first in the turn itself. The block may repeat on
 * later turns, so it states the current instructions rather than announcing a change. A briefing on
 * what the session missed (ADR 017) comes next, then the user's prompt. `instructions` is the
 * whole text the system prompt would append, notes included, so a resumed session gets them too.
 */
export const turnPrompt = (
  request: Pick<PromptRequest, "prompt" | "briefing" | "sessionId" | "instructions" | "instructionsChanged">,
  instructions: string = request.instructions,
  commits = "",
) => {
  const current =
    request.sessionId && request.instructionsChanged
      ? [
          "<current-instructions>",
          "These are your current instructions. Follow them in place of the ones in your system prompt and any earlier ones:",
          "",
          instructions,
          "</current-instructions>",
          "",
        ]
      : [];
  const briefing = request.briefing ? [request.briefing, ""] : [];
  // A resumed session keeps its first system prompt, so who it commits as now is said again (#741).
  const identity = request.sessionId && commits !== "" ? ["<commit-identity>", commits, "</commit-identity>", ""] : [];
  return [...current, ...identity, ...briefing, request.prompt].join("\n");
};

/**
 * What a Claude Code turn starts with: its tools, how its commands commit, and the system prompt
 * and prompt it is sent, which say who its commits are made as (#586, #741). `sandboxOn` says
 * whether the sandbox wraps it.
 */
export const claudeTurnStart = (request: PromptRequest, policySandboxState: SandboxState, sandboxOn: boolean) => {
  const tools = toolTurn(request.tools, policySandboxState, request.hubTools);
  const commits = turnCommits(tools);
  const instructions = turnInstructions(
    request.instructions,
    tools !== null && sandboxOn,
    tools !== null && Boolean(request.approvals),
    tools?.commitAs,
    commits.note,
  );
  const asked = askedMount(request.askedSkill, request.skills);
  const prompt = askedSkillPrompt(turnPrompt(request, instructions, commits.now), asked);
  return { tools, commits, instructions, prompt, asked: asked?.name ?? null, askedSet: asked?.set?.name ?? null };
};

/** A turn with tools: the context every call is decided under, its folders and the tools offered. */
export interface ToolTurn {
  readonly context: PolicyContext;
  /** Canonical and existing; the first is where Claude Code starts. */
  readonly folders: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  /** Claude Code's configuration folder for this hob. */
  readonly runtimeFolder: string;
  /** The hub tool a `git push` command in a folder is pointed to, when the turn offers one (ADR 020). */
  readonly steersPush?: (cwd: string) => Effect.Effect<string | null>;
  /** The hub tool a `git init` command is pointed to, when the turn offers it (ADR 014). */
  readonly initTool?: string;
  /** The hob's bot, when it has its own GitHub App: its commands commit as it (ADR 022). */
  readonly commitAs?: CommitIdentity;
  /** Who its commits are made as, as the hub settled it (#586, #741), which a refused identity override names. */
  readonly commitsAs: CommitsAs;
}

/**
 * The user's signing agent a sandboxed turn's commands may reach, or undefined. The hob signs commits
 * with the user's 1Password key only when the user turned that on, and never as its own app's bot:
 * the user's key never vouches for a bot's commits, and GitHub signs them when it pushes (ADR 022).
 */
export const turnSigningAgent = (
  sandboxedTools: ToolTurn | null,
  agentSocket: () => string | undefined = onePasswordAgentSocket,
): string | undefined =>
  sandboxedTools !== null && sandboxedTools.commitAs === undefined && sandboxedTools.context.hob.signCommits === true
    ? agentSocket()
    : undefined;

/** What `SessionStarted` says of the policy the turn's tools run under, so its Attempt records it (ADR 018). */
export const sessionPolicy = (tools: ToolTurn | null): { readonly policyVersion?: string } =>
  tools === null ? {} : { policyVersion: policyVersion(tools.context) };

/**
 * The turn's tools, or null for a chat-only turn: no access, no folder that exists, reading the
 * folders denied (Claude Code cannot start in a folder it cannot read), or no tool open.
 */
export const toolTurn = (
  access: ToolAccess | null | undefined,
  sandbox: SandboxState,
  hubTools?: HubTools | null,
  modelHosts: ReadonlyArray<string> = CLAUDE_CODE_MODEL_HOSTS,
): ToolTurn | null => {
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
  const context: PolicyContext = { ...access.policy, sandbox, modelHosts };
  if (operationDecision(context, "read-files") === "deny") return null;
  const tools = offeredTools(context);
  if (tools.length === 0) return null;
  return {
    context,
    folders,
    tools,
    runtimeFolder: access.runtimeFolder,
    ...(hubTools?.steersPush ? { steersPush: hubTools.steersPush } : {}),
    ...(hubTools?.tools.some((tool) => tool.name === GIT_INIT_TOOL) ? { initTool: GIT_INIT_TOOL } : {}),
    ...(access.commitAs ? { commitAs: access.commitAs } : {}),
    commitsAs: access.commitsAs,
  };
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
  record?: PromptRequest["recordToolStart"],
  background?: BackgroundCommands | null,
  skillFolder?: string | null,
): { readonly hooks: NonNullable<Options["hooks"]>; readonly canUseTool: CanUseTool } => {
  const label = (tool: string, input: Record<string, unknown>) => toolLabel(tool, input, redaction?.text);
  const started = new Set<string>();
  // What the hob is told with the result of each call the user approved.
  const notes = new Map<string, string>();
  // Each call as the hook saw it, so the permission callback decides the same call in the same folder.
  const seen = new Map<string, ToolCall>();
  // Where Claude Code saves this session's large outputs, which the hob may read (#1153).
  let outputs: ReadonlyArray<RuntimeOutput> = [];
  const context = (): PolicyContext =>
    outputs.length === 0 ? turn.context : { ...turn.context, runtimeOutputs: outputs };
  // Answers whether the call may run: it is recorded first when the turn records calls (EX-004).
  const begin = async (id: string, tool: string, input: Record<string, unknown>, verdict: PolicyVerdict) => {
    // A command's folder is the one its call was decided on.
    const command = commandOf(
      tool,
      input,
      verdict.targets[0] ?? (turn.folders[0] as string),
      turn.context.sandbox === "on",
    );
    const event = {
      _tag: "ToolStarted",
      id,
      tool,
      operation: verdict.operation,
      targets: verdict.targets,
      label: label(tool, input),
      ...(command === undefined ? {} : { command }),
    } as const;
    const recorded = await Effect.runPromise(startCall(record, report, event));
    if (recorded) started.add(id);
    return recorded;
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
  const unrecorded = (decision: CallDecision): CallDecision => ({
    _tag: "Refuse",
    verdict: decision.verdict,
    reason: UNRECORDED_TOOL_CALL,
  });

  const preToolUse: HookCallback = async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const saved = savedOutputFolder(turn.runtimeFolder, input);
    if (saved !== undefined) outputs = [{ root: turn.runtimeFolder, folder: saved }];
    const tool = input.tool_name;
    // The hub decides its own tools' calls (ADR 018); the turn allows them by name.
    if (hubToolOf(tool) !== null) return {};
    // A mounted skill's instructions are the hob's to read; the skills hook decides those (ADR 029).
    if (tool === SKILL_TOOL) return {};
    // A read of a skill's own files, or its set's, is the skills hook's to allow (ADR 029, Skill sets).
    if (tool === READ_TOOL && readsSkillFile(input.tool_input, skillFolder)) return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const call = { id: input.tool_use_id, tool, input: toolInput, cwd: input.cwd || (turn.folders[0] as string) };
    // Only the policy decides here; asking the user waits in the permission callback.
    const decision = await Effect.runPromise(
      decideCall(engine, context(), null, call, report, turn.commitsAs, redaction, turn.steersPush, turn.initTool),
    ).catch(() => failed(tool));
    if (decision._tag === "Run") {
      if (!(await begin(call.id, tool, toolInput, decision.verdict))) {
        const reason = refuse(call.id, tool, toolInput, unrecorded(decision));
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      }
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

  const finished: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    let output: string | undefined;
    if (started.delete(input.tool_use_id)) {
      // Claude Code keeps an output too large to return inline in its configuration folder.
      output =
        input.hook_event_name === "PostToolUse"
          ? await fullToolOutput(input.tool_name, input.tool_response, [turn.runtimeFolder, userConfigFolder()])
          : input.error;
      // A command that went on in the background has not finished: its task's end reports it (#1018).
      if (!(await background?.moved(input.tool_use_id, input))) report(toolFinished(input.tool_use_id, input, output));
    }
    // The notes go with the result, so the hob knows it asked as it would know of a refusal, and
    // what to do with a .git its sandbox kept from a delete (#663).
    const kept = keptGitHint(input.tool_name, output, turn.initTool);
    const note = [notes.get(input.tool_use_id), kept].filter((part) => part !== undefined).join(" ") || undefined;
    notes.delete(input.tool_use_id);
    // A command prints in color for the Workbench; the hob reads its output plain (#902).
    const plain =
      input.hook_event_name === "PostToolUse" ? plainBashResponse(input.tool_name, input.tool_response) : undefined;
    if (note === undefined && plain === undefined) return {};
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        ...(note === undefined ? {} : { additionalContext: note }),
        ...(plain === undefined ? {} : { updatedToolOutput: plain }),
      },
    };
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
    const decision = await Effect.runPromise(
      decideCall(engine, context(), approvals, call, report, turn.commitsAs, redaction, turn.steersPush, turn.initTool),
      {
        signal: options.signal,
      },
    ).catch(() => failed(tool));
    if (decision._tag === "Run") {
      // A call the hook allowed was recorded then.
      if (started.has(call.id) || (await begin(call.id, tool, input, decision.verdict))) {
        if (decision.approval) notes.set(call.id, approvalNote(decision.approval));
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: refuse(call.id, tool, input, unrecorded(decision)) };
    }
    return { behavior: "deny", message: refuse(call.id, tool, input, decision) };
  };

  return {
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [finished] }],
      PostToolUseFailure: [{ hooks: [finished] }],
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

/** Where a turn's skill folders go: the hob's runtime folder, or the hub's own folder for a chat. */
const skillsBase = (tools: ToolTurn | null, config: ClaudeCodeConfig) => tools?.runtimeFolder ?? config.workspaceDir;

/**
 * A run's events, and once a run has replied while background commands still run, that the turn now
 * waits on them (#1056): Claude Code wakes the session when one ends, so the turn goes on until then.
 */
export const awaitingAfter = (
  events: ReadonlyArray<RuntimeEvent>,
  background: Pick<BackgroundCommands, "waiting">,
): ReadonlyArray<RuntimeEvent> => {
  if (!events.some((event) => event._tag === "Completed")) return events;
  const ids = background.waiting();
  return ids.length === 0 ? events : [...events, { _tag: "AwaitingCommands", ids }];
};

/** Hands a turn's background commands each task end Claude Code reports (#1018). */
const taskEnds = (background: BackgroundCommands) => (message: unknown) =>
  isTaskEnd(message) ? Effect.promise(() => background.ended(message)) : Effect.void;

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

    // Looked up on every use, so installing, moving or updating Claude Code needs no restart;
    // `claude --version` reruns when the file changes (as `claude update` does).
    const locate = binaryLocator({
      find: () => findClaudeCode(config.executable),
      parse: parseVersion,
      env: runtimeEnv,
      minimum: minimumClaudeCodeVersion,
    });

    const notStarted = `Claude Code could not be started. ${installGuidance}`;
    const signedOut =
      "Claude Code is not signed in. Run `claude` in a terminal and sign in with your claude.ai account.";
    const outdated = `Hobbots needs Claude Code ${minimumClaudeCodeVersion} or later. Run \`claude update\`.`;

    const words = { name: "Claude Code", install: installGuidance, notStarted, outdated };
    const executable = runnableBinary(locate, words);

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
      // A turn that carries hub tools serves them as an in-process MCP server (withHubTools), verified
      // with Claude Code 2.1.316 on macOS (#893).
      hubTools: {
        status: "verified",
        evidence:
          "Charms and coordination tools are served as an MCP server on Claude Code's control channel and decided by the hub.",
      },
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
          const start = claudeTurnStart(request, policySandbox(declared), sandbox.state === "on");
          const { tools, commits } = start;
          const sandboxed = tools !== null && sandbox.state === "on";
          const commitAs = tools?.commitAs;
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
          const signingAgent = turnSigningAgent(sandboxed ? tools : null);
          // A hob's commands print in color (#902).
          const colorScript = yield* commandColorFile(tools);
          // The turn's skills, in a folder of their own for as long as it runs (ADR 029).
          const skills = yield* holdSkillFolder(skillsBase(tools, config), request.skills);
          const prepared = sandboxed
            ? yield* Effect.acquireRelease(
                sandbox.prepare({
                  folders: tools.folders,
                  folderAccess: folderAccessFor(tools.context),
                  dataFolder: tools.context.dataFolder,
                  binary: absoluteBinary,
                  runtimeFolder: tools.runtimeFolder,
                  ...(signingAgent ? { signingAgent } : {}),
                  ...(commitAs ? { commitAs } : {}),
                  ...skillFolderScope(skills),
                  allowedHosts: CLAUDE_CODE_MODEL_HOSTS,
                  // The hob's own grants as they are now can answer the preset's Ask for a host (ADR 015).
                  decideHost: grantedHosts(engine, tools.context, request.approvals),
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
              : { ...options, env: withCommitIdentity(options.env, commitAs) };
            const spawned = spawn(command, args, {
              cwd: options.cwd,
              env: commits.env(env),
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
          const report = (event: RuntimeEvent) => Queue.offerUnsafe(queue, event);
          // A call that goes on in the background is reported finished when its task ends.
          const background = backgroundCommands(report);
          const turn = yield* Effect.acquireRelease(
            Effect.sync(() =>
              query({
                prompt: start.prompt,
                options: withHubTools(
                  withSkills(
                    {
                      ...base,
                      ...(tools
                        ? toolOptions(
                            tools,
                            policyHooks(
                              engine,
                              tools,
                              report,
                              request.approvals,
                              request.redaction,
                              request.recordToolStart,
                              background,
                              skills?.folder ?? null,
                            ),
                            // Only Hobbots' script: one the hub was started with never reaches the commands.
                            { ...base.env, [COMMAND_ENV_FILE_VARIABLE]: colorScript },
                          )
                        : {}),
                      abortController,
                      spawnClaudeCodeProcess,
                      includePartialMessages: true,
                      systemPrompt: {
                        type: "preset",
                        preset: "claude_code",
                        append: start.instructions,
                      },
                      ...(request.sessionId ? { resume: request.sessionId } : {}),
                      // A turn of no hob's keeps no session on disk.
                      ...(request.ephemeral ? { persistSession: false } : {}),
                      // Claude Code's own command sandbox, where it applies one, must let Git reach the agent too.
                      ...(signingAgent ? { sandbox: { network: { allowUnixSockets: [signingAgent] } } } : {}),
                      ...brainOptions(request),
                    },
                    skills,
                    request.skills,
                    report,
                  ),
                  request.hubTools,
                  report,
                  request.recordToolStart,
                ),
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
          const toEvents = turnEvents(tools);
          const whole = wholeTurn(start.asked, start.askedSet);
          // Tool events arrive from the hooks while the turn runs, so the turn's own events share their queue.
          yield* Stream.fromAsyncIterable(turn, errorMessage).pipe(
            // A background command's end arrives as its task's notification.
            Stream.tap(taskEnds(background)),
            Stream.mapEffect((message) =>
              Effect.try({
                try: () => awaitingAfter(toEvents(message), background).flatMap(whole.read),
                catch: errorMessage,
              }),
            ),
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
          yield* Queue.offerAll(queue, whole.end());
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

    // Finds the host's Claude Code and checks its version before starting it. Starting Claude Code
    // takes seconds, so each binary's model list is kept for a while; the account or a managed model
    // policy can change it without a new binary, so it is fetched again when it expires.
    const { health, models } = installedRuntimeChecks({
      locate,
      words,
      notFound: runtimeHealth,
      probe,
      fallbackModels,
      listModels: (binary) =>
        askIdleSession(binary, (session) => session.supportedModels()).pipe(
          Effect.map((listed) => (listed.length === 0 ? fallbackModels : toRuntimeModels(listed))),
        ),
    });

    // `/usage` is a local command: Claude Code answers it from the plan's usage endpoint without a
    // model request, so reading the meters spends none of them. The session is not saved.
    const readPlan = (binary: string) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          query({ prompt: "/usage", options: { ...baseOptions(config, binary), persistSession: false } }),
        ),
        (session) => Effect.sync(() => session.close()),
      ).pipe(
        Effect.flatMap((session) =>
          Effect.tryPromise({
            try: async () => {
              for await (const message of session) {
                if (message.type === "assistant" && message.usage_report !== undefined) return message.usage_report;
                if (message.type === "result") return undefined;
              }
              return undefined;
            },
            catch: errorMessage,
          }),
        ),
        Effect.timeout(checkTimeout),
        Effect.scoped,
      );

    const planUsage = installedPlanUsage({
      runtime: "claude-code",
      locate,
      read: (binary, checkedAt) => readPlan(binary).pipe(Effect.map((report) => planFromReport(report, checkedAt))),
    });

    return RuntimeAdapter.of({ health, models, enforcement: Effect.succeed(declared), planUsage, sendPrompt });
  });

/** Claude Code with tools under the hub's policy engine and process sandbox. */
export const ClaudeCodeLayer = (config: ClaudeCodeConfig) => Layer.effect(RuntimeAdapter, makeClaudeCode(config));
