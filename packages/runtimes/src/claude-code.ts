import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  type AccountInfo,
  type ModelInfo,
  type Options,
  query,
  type SDKMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { RuntimeHealth, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Clock, DateTime, Duration, Effect, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, RuntimeError, type RuntimeEvent } from "./adapter.ts";

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

// Chat-only until the permission broker exists: no built-in tools, nothing auto-approved,
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
const withStderr = (error: RuntimeError, child: ChildProcess | undefined, tail: string) =>
  child && tail !== "" && ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null)
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

const toEvents = (message: SDKMessage): ReadonlyArray<RuntimeEvent> => {
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
      if (
        message.parent_tool_use_id === null &&
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        return [{ _tag: "TextDelta", text: event.delta.text }];
      }
      return [];
    }
    case "result":
      if (message.subtype !== "success" || message.is_error) {
        throw new RuntimeError({
          message: message.subtype === "success" ? message.result : `Claude Code turn ended: ${message.subtype}`,
        });
      }
      return [
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

const errorMessage = (error: unknown) =>
  error instanceof RuntimeError
    ? error
    : new RuntimeError({
        message: error instanceof Error ? error.message : String(error),
      });

export const makeClaudeCode = (config: ClaudeCodeConfig) =>
  Effect.gen(function* () {
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

    const sendPrompt = (request: PromptRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const binary = yield* executable;
          const abortController = new AbortController();
          // Hobbots starts the process itself so it can tell when it has really exited.
          let child: ChildProcess | undefined;
          let stderr: ReturnType<typeof stderrTail> | undefined;
          const spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }: SpawnOptions) => {
            const spawned = spawn(command, args, {
              cwd,
              env,
              signal,
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
                  ...baseOptions(config, binary),
                  abortController,
                  spawnClaudeCodeProcess,
                  includePartialMessages: true,
                  systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    append: request.instructions,
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
              }).pipe(Effect.andThen(child ? exited(child) : Effect.void)),
          );
          return Stream.fromAsyncIterable(turn, errorMessage).pipe(
            Stream.mapEffect((message) => Effect.try({ try: () => toEvents(message), catch: errorMessage })),
            Stream.flattenIterable,
            Stream.catch((error) =>
              Stream.unwrap(
                (stderr ? stderr.read : Effect.succeed("")).pipe(
                  Effect.map((tail) => Stream.fail(withStderr(error, child, tail))),
                ),
              ),
            ),
          );
        }),
      );

    const runtimeHealth = (fields: Pick<RuntimeHealth, "availability" | "version" | "detail" | "checkedAt">) =>
      new RuntimeHealth({ runtime: "claude-code", billing: null, ...fields });

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

    return RuntimeAdapter.of({ health, models, sendPrompt });
  });

export const ClaudeCodeLayer = (config: ClaudeCodeConfig) => Layer.effect(RuntimeAdapter, makeClaudeCode(config));
