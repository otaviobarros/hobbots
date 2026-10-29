import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeHealth } from "@hobbots/domain";
import { DateTime, Effect, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, RuntimeError, type RuntimeEvent } from "./adapter.ts";

export interface ClaudeCodeConfig {
  /** Empty working folder the runtime is confined to. */
  readonly workspaceDir: string;
  /** Claude Code binary to run instead of the one found on this machine. */
  readonly executable?: string | undefined;
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
          const turn = yield* Effect.acquireRelease(
            Effect.sync(() =>
              query({
                prompt: request.prompt,
                options: {
                  ...baseOptions(config, binary),
                  abortController,
                  includePartialMessages: true,
                  systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    append: request.instructions,
                  },
                  ...(request.sessionId ? { resume: request.sessionId } : {}),
                  ...(request.model ? { model: request.model } : {}),
                },
              }),
            ),
            (turn) =>
              Effect.sync(() => {
                abortController.abort();
                turn.close();
              }),
          );
          return Stream.fromAsyncIterable(turn, errorMessage).pipe(
            Stream.mapEffect((message) => Effect.try({ try: () => toEvents(message), catch: errorMessage })),
            Stream.flattenIterable,
          );
        }),
      );

    const runtimeHealth = (fields: Pick<RuntimeHealth, "availability" | "version" | "detail" | "checkedAt">) =>
      new RuntimeHealth({ runtime: "claude-code", billing: null, ...fields });

    // Starts Claude Code without sending a prompt, so the check costs no usage.
    const probe = (binary: string, version: string, checkedAt: string) =>
      Effect.tryPromise({
        try: async () => {
          const idle: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise(() => {}),
            }),
          };
          const session = query({ prompt: idle, options: baseOptions(config, binary) });
          try {
            const account = await session.accountInfo();
            return new RuntimeHealth({
              runtime: "claude-code",
              availability: "ready",
              billing: billingFrom(account.apiKeySource, account.subscriptionType),
              version,
              detail: account.email ?? null,
              checkedAt,
            });
          } finally {
            session.close();
          }
        },
        catch: errorMessage,
      }).pipe(
        Effect.timeout("30 seconds"),
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

    return RuntimeAdapter.of({ health, sendPrompt });
  });

export const ClaudeCodeLayer = (config: ClaudeCodeConfig) => Layer.effect(RuntimeAdapter, makeClaudeCode(config));
