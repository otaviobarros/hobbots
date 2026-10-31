import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxState } from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import { RuntimeError } from "./adapter.ts";

/**
 * The OS sandbox a runtime with tools starts in (ADR 014). Commands, and the runtime itself, run
 * under sandbox-runtime: they read and write only the hob's folders and what the runtime needs,
 * and reach the network only through its proxy. One sandbox serves the whole hub; each turn gets
 * its own folders and allow list.
 */

/** Hosts Claude Code needs with a claude.ai login: its API, and sign-in to refresh tokens. */
export const CLAUDE_CODE_MODEL_HOSTS: ReadonlyArray<string> = [
  "api.anthropic.com",
  "console.anthropic.com",
  "platform.claude.com",
  "claude.ai",
];

// Mirrors `isBlockedHost` in @hobbots/permissions, so the proxy refuses what the engine would.
const DENIED_DOMAINS = ["localhost", "*.localhost", "metadata.google.internal", "metadata.goog"];
const DENIED_ADDRESSES = [
  "127.0.0.0/8",
  "0.0.0.0/8",
  "169.254.0.0/16",
  "100.100.100.200",
  "::/128",
  "::1/128",
  "fe80::/10",
  "fd00:ec2::254",
];

/** What one turn may touch. Every path is absolute; folders are canonical. */
export interface SandboxScope {
  readonly folders: ReadonlyArray<string>;
  /** Hobbots' data folder, which stays closed even inside a folder. */
  readonly dataFolder: string;
  /** The runtime's binary, absolute, whose folder (and its real location) must stay readable. */
  readonly binary: string;
  /**
   * The runtime's own state for this hob, such as Claude Code's configuration folder. The folder that
   * holds every hob's stays closed, and so does the user's own runtime state.
   */
  readonly runtimeFolder: string;
  /** The turn's own temporary folder. */
  readonly tempFolder: string;
  /** Hosts the turn always reaches, such as its model API. */
  readonly allowedHosts: ReadonlyArray<string>;
  /** Decides any other host the turn's processes try to reach. */
  readonly decideHost?: HostDecider;
  readonly home?: string;
  readonly path?: string;
  /** The closed places outside the home folder; USER_DATA_ROOTS that exist by default. */
  readonly roots?: ReadonlyArray<string>;
}

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Where people keep files outside the home folder: other users, volumes, shared and temporary
 * folders (other turns' included). Closed for reading like the home folder, apart from the folders.
 */
export const USER_DATA_ROOTS: ReadonlyArray<string> = [
  "/Users",
  "/home",
  "/Volumes",
  "/media",
  "/mnt",
  "/srv",
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
];

/** The user's own Claude Code state, which its later runs load outside any policy. */
const userClaudeCode = (home: string) => {
  const folder = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [folder, join(home, ".claude.json")];
};

/**
 * The turn's filesystem rules. The home folder and the other places people keep files are closed
 * except for the folders, the hob's runtime state and the tools on PATH, so other projects, keys,
 * dotfiles and the user's own Claude Code state stay out of reach.
 */
export const sandboxFilesystem = (scope: SandboxScope): SandboxRuntimeConfig["filesystem"] => {
  const home = scope.home ?? homedir();
  const binaryDirs = [dirname(scope.binary), dirname(realOrSelf(scope.binary))];
  // Tools installed under the home folder (version managers, ~/.local/bin) stay readable, not writable.
  const homeTools = (scope.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir) && dir.startsWith(`${home}/`));
  return {
    denyRead: [
      ...new Set([
        ...(scope.roots ?? USER_DATA_ROOTS),
        home,
        scope.dataFolder,
        dirname(scope.runtimeFolder),
        ...userClaudeCode(home),
      ]),
    ],
    allowRead: [...new Set([...scope.folders, scope.runtimeFolder, scope.tempFolder, ...binaryDirs, ...homeTools])],
    allowWrite: [...scope.folders, scope.runtimeFolder, scope.tempFolder],
    denyWrite: [
      scope.dataFolder,
      // Loaded later by the user's own Claude Code, outside any policy.
      ...userClaudeCode(home),
      // Git's hooks and config, in each folder and in any repository below it, submodules' included:
      // the user's own Git would run what a hob writes there outside the sandbox. sandbox-runtime
      // protects these only under the hub's own working folder on macOS. A repository a hob lays out
      // itself, such as one a `.git` file points to, is not covered (ADR 014).
      ...scope.folders.flatMap((folder) => [
        join(folder, ".git", "hooks"),
        join(folder, ".git", "config"),
        `${folder}/**/.git/**/hooks/**`,
        `${folder}/**/.git/**/config`,
        `${folder}/**/.git/hooks/**`,
        `${folder}/**/.git/config`,
      ]),
    ],
  };
};

/** Whether a turn may reach a host it has no rule for: true, or the reason it may not. */
export type HostDecider = (host: string) => Promise<true | string>;

/**
 * The proxy asks about a host without saying which turn asked, so the answer must hold for every
 * live turn: a host is reached only when each of them may reach it, and never with none live.
 */
export const decideForLiveTurns = async (
  deciders: Iterable<HostDecider>,
  host: string,
): Promise<true | { readonly allow: false; readonly reason: string }> => {
  const answers = await Promise.all(
    Array.from(deciders, (decide) => decide(host).catch(() => `${host} could not be checked.`)),
  );
  if (answers.length === 0) return { allow: false, reason: `${host} is not allowed for this hob.` };
  const refusal = answers.find((answer) => answer !== true);
  return refusal === undefined ? true : { allow: false, reason: refusal };
};

// Variables that pass into the sandbox as they are. Anything else, such as a token the hub was
// started with or an SSH agent socket, stays out, so commands cannot use the hub's credentials.
const PASSED_VARIABLES = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "COLORTERM", "TZ"]);
const PASSED_PREFIXES = ["LC_", "CLAUDE_CODE_", "CLAUDE_AGENT_SDK_"];
// Claude Code's own settings pass, but never one that looks like a credential, such as a refresh
// token; the turn's sign-in is added on its own.
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/;
const SIGN_IN = "CLAUDE_CODE_OAUTH_TOKEN";

/** The part of an environment that enters the sandbox. */
export const sandboxEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined &&
        (PASSED_VARIABLES.has(key) ||
          key === SIGN_IN ||
          (PASSED_PREFIXES.some((prefix) => key.startsWith(prefix)) && !SECRET_NAME.test(key))),
    ),
  );

/** Quotes a word for a POSIX shell. */
export const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** A sandbox prepared for one turn: how to start a process in it, and what to undo afterwards. */
export interface PreparedSandbox {
  /** The spawn arguments that run `command` inside the sandbox. */
  readonly spawnArgs: (
    command: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => { readonly command: string; readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv };
  readonly release: () => void;
}

export interface ProcessSandboxShape {
  /** "on" when the sandbox started on this hub, "unavailable" with the reason otherwise. */
  readonly state: SandboxState;
  readonly evidence: string;
  /** Prepares the sandbox with one turn's rules. */
  readonly prepare: (scope: Omit<SandboxScope, "tempFolder">) => Effect.Effect<PreparedSandbox, RuntimeError>;
}

// The runtime's command line reaches the wrapped shell in this variable, already quoted, because the
// wrap is prepared before the runtime's arguments are known. The shell removes it before running them.
const COMMAND_VARIABLE = "HOBBOTS_SANDBOXED_COMMAND";
const LAUNCHER = `c=$${COMMAND_VARIABLE}; unset ${COMMAND_VARIABLE}; eval "exec $c"`;

export class ProcessSandbox extends Context.Service<ProcessSandbox, ProcessSandboxShape>()(
  "@hobbots/runtimes/ProcessSandbox",
) {
  /** A sandbox that never starts, for tests and hubs that run without one. */
  static readonly unavailable = (evidence: string) =>
    Layer.succeed(
      ProcessSandbox,
      ProcessSandbox.of({
        state: "unavailable",
        evidence,
        prepare: () => Effect.fail(new RuntimeError({ message: `The sandbox is unavailable: ${evidence}` })),
      }),
    );

  /** Starts sandbox-runtime once for the hub, and stops it with the hub. */
  static readonly layer = Layer.effect(
    ProcessSandbox,
    Effect.gen(function* () {
      if (!SandboxManager.isSupportedPlatform()) {
        return ProcessSandbox.of({
          state: "unavailable",
          evidence: `sandbox-runtime does not support ${platform()}`,
          prepare: () => Effect.fail(new RuntimeError({ message: "The sandbox is unavailable on this platform." })),
        });
      }
      const dependencies = SandboxManager.checkDependencies();
      if (dependencies.errors.length > 0) {
        const evidence = `sandbox-runtime is missing: ${dependencies.errors.join("; ")}`;
        return ProcessSandbox.of({
          state: "unavailable",
          evidence,
          prepare: () => Effect.fail(new RuntimeError({ message: evidence })),
        });
      }
      // The live turns' host rules, by the id their processes present to the proxy.
      const liveTurns = new Map<string, HostDecider>();
      const started = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          SandboxManager.initialize(
            {
              network: {
                // Nothing is open by default; each turn registers its own list.
                allowedDomains: [],
                deniedDomains: DENIED_DOMAINS,
                deniedResolvedAddresses: DENIED_ADDRESSES,
              },
              // Every wrap passes its own filesystem rules; these close everything else.
              filesystem: { denyRead: [homedir()], allowWrite: [], denyWrite: [] },
            },
            ({ host }) => decideForLiveTurns(liveTurns.values(), host),
          ),
        ).pipe(Effect.result),
        (result) => (result._tag === "Success" ? Effect.promise(() => SandboxManager.reset()) : Effect.void),
      );
      if (started._tag === "Failure") {
        const evidence = `sandbox-runtime did not start: ${String(started.failure)}`;
        return ProcessSandbox.of({
          state: "unavailable",
          evidence,
          prepare: () => Effect.fail(new RuntimeError({ message: evidence })),
        });
      }

      const prepare: ProcessSandboxShape["prepare"] = (scope) =>
        Effect.tryPromise({
          try: async (): Promise<PreparedSandbox> => {
            mkdirSync(scope.runtimeFolder, { recursive: true, mode: 0o700 });
            const tempFolder = realOrSelf(mkdtempSync(join(tmpdir(), "hobbots-turn-")));
            // The proxy knows the turn by this id alone, so it must be unguessable (128 bits or more).
            const commandId = randomBytes(16).toString("base64url");
            const release = () => {
              liveTurns.delete(commandId);
              SandboxManager.unregisterCommandNetworkLists(commandId);
              rmSync(tempFolder, { recursive: true, force: true });
            };
            try {
              SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: [...scope.allowedHosts] });
              liveTurns.set(commandId, scope.decideHost ?? (async (host) => `${host} is not allowed for this hob.`));
              const wrapped = await SandboxManager.wrapWithSandboxArgv(
                LAUNCHER,
                undefined,
                {
                  filesystem: sandboxFilesystem({
                    ...scope,
                    tempFolder,
                    roots: USER_DATA_ROOTS.filter((root) => existsSync(root)),
                  }),
                },
                undefined,
                // The protected Git paths are found from here and the allowed folders.
                scope.folders[0],
                { commandId, commandText: "runtime" },
              );
              const [shell, ...shellArgs] = wrapped.argv;
              // Only what the wrap adds is taken from its environment: on macOS it returns the hub's
              // own, which would bring back variables the runtime's environment removed.
              const added = Object.fromEntries(
                Object.entries(wrapped.env).filter(([key, value]) => process.env[key] !== value),
              );
              return {
                spawnArgs: (command, args, env) => ({
                  command: shell as string,
                  args: shellArgs,
                  env: {
                    ...sandboxEnv(env),
                    ...added,
                    // The runtime keeps its state for this hob there, never in the user's own.
                    CLAUDE_CONFIG_DIR: scope.runtimeFolder,
                    TMPDIR: tempFolder,
                    // Claude Code keeps its own temporary files under /tmp otherwise, outside the sandbox's reach.
                    CLAUDE_CODE_TMPDIR: tempFolder,
                    // Claude Code keeps its sign-in to itself: commands, hooks and MCP servers start without it.
                    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
                    [COMMAND_VARIABLE]: [command, ...args].map(shellQuote).join(" "),
                  },
                }),
                release,
              };
            } catch (error) {
              release();
              throw error;
            }
          },
          catch: (error) =>
            new RuntimeError({
              message: `The sandbox could not start the runtime: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

      return ProcessSandbox.of({
        state: "on",
        evidence: `sandbox-runtime on ${platform()}`,
        prepare,
      });
    }),
  );
}
