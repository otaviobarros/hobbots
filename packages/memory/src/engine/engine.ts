import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { MemoryEngineExit, MemoryEngineHealth, MemoryEngineOffReason } from "@hobbots/domain";
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  type Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { verifyEngine } from "./binary.ts";
import { configHoldsCredential, type EngineSettings, NO_MODEL, renderEngineConfig } from "./config.ts";
import type { MemoryKeys } from "./keys.ts";
import { AI_MEMORY_VERSION } from "./release.ts";

/** The one ai-memory workspace of an installation (ADR 028). */
export const MEMORY_WORKSPACE = "hobbots";

/** Where a running engine answers, and the hub's keys for it. Never shown, logged or given to a hob. */
export interface MemoryEndpoint {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  readonly url: string;
  readonly root: Redacted.Redacted<string>;
  readonly proxy: Redacted.Redacted<string>;
}

export interface MemoryEngineShape {
  /** The engine's health now, for Settings › Diagnostics. */
  readonly health: Effect.Effect<MemoryEngineHealth>;
  /** Where the engine answers while it runs; none while it starts, restarts or is off. */
  readonly endpoint: Effect.Effect<Option.Option<MemoryEndpoint>>;
  /**
   * Applies new engine settings, such as the memory model. The engine reads them only at start, so
   * a change restarts the engine's process, never the hub; the same settings change nothing.
   */
  readonly reconfigure: (settings: EngineSettings) => Effect.Effect<void>;
}

export interface MemoryEngineOptions {
  /** The folder holding the `ai-memory` binary and its `ai-memory.sha256`. */
  readonly folder: string;
  /** The hub's data folder; the engine keeps its data in `memory/` inside it. */
  readonly dataDir: string;
  readonly keys: MemoryKeys;
  readonly settings?: EngineSettings | undefined;
  /** How long a start may take before it counts as failed. */
  readonly startTimeout?: Duration.Input | undefined;
  /** The first wait before a restart; each failed start doubles it, up to `maxBackoff`. */
  readonly firstBackoff?: Duration.Input | undefined;
  readonly maxBackoff?: Duration.Input | undefined;
  /** A run that answered this long resets the backoff, so a rare crash restarts at once. */
  readonly stableAfter?: Duration.Input | undefined;
  /** How often a running engine is asked whether it still answers. */
  readonly checkEvery?: Duration.Input | undefined;
}

/** Why one run of the engine ended. */
class EngineRunEnded extends Data.TaggedError("EngineRunEnded")<{ readonly stable: boolean }> {}

/** A start that never got the engine running: its config, its port or its process could not be had. */
class EngineLaunchFailed extends Data.TaggedError("EngineLaunchFailed")<{ readonly cause: unknown }> {}

/** The binary failed its check before a start, so memory stays off until the hub starts again. */
class EngineTurnedOff extends Data.TaggedError("EngineTurnedOff")<{ readonly reason: MemoryEngineOffReason }> {}

/** Missed health checks in a row after which a running engine counts as hung and is restarted. */
const MISSED_CHECKS = 3;

/** A loopback port no listener holds right now. */
const freePort = Effect.callback<number, Error>((resume) => {
  const server = createServer();
  server.once("error", (error) => resume(Effect.fail(error)));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(port > 0 ? Effect.succeed(port) : Effect.fail(new Error("No free port"))));
  });
});

/**
 * The engine's whole environment (ADR 028): the two bearers, which reach it nowhere else, and only
 * what a process needs to run. The hub's own environment, with its provider keys and tokens, is not
 * passed on. `HOME` is the engine's data folder, so it reads none of the user's own settings, such
 * as an ai-memory or Git configuration of theirs.
 */
export const engineEnvironment = (
  keys: MemoryKeys,
  memoryDir: string,
): Record<string, string | Redacted.Redacted<string>> => ({
  AI_MEMORY_AUTH_TOKEN: keys.root,
  AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN: keys.proxy,
  HOME: memoryDir,
  PATH: "/usr/bin:/bin",
  NO_COLOR: "1",
});

/** The command line of one engine start. Never `ai-memory run`, hooks or the agent installers. */
export const engineArguments = (port: number, memoryDir: string, configFile: string): ReadonlyArray<string> => [
  "serve",
  "--transport",
  "http",
  "--bind",
  `127.0.0.1:${port}`,
  "--data-dir",
  memoryDir,
  "--config",
  configFile,
  // The read-only `/api/v1` the Memory page reads, without the engine's own web pages.
  "--enable-api",
  "--workspace",
  MEMORY_WORKSPACE,
];

interface Status {
  readonly state: MemoryEngineHealth["state"];
  readonly offReason: MemoryEngineOffReason | null;
  readonly restarts: number;
  readonly lastExit: MemoryEngineExit | null;
  readonly runningSince: string | null;
  readonly endpoint: Option.Option<MemoryEndpoint>;
}

const offHealth = (offReason: MemoryEngineOffReason): MemoryEngineHealth => ({
  state: "off",
  offReason,
  version: AI_MEMORY_VERSION,
  restarts: 0,
  lastExit: null,
  runningSince: null,
});

const offEngine = (reason: MemoryEngineOffReason): MemoryEngineShape => ({
  health: Effect.succeed(offHealth(reason)),
  endpoint: Effect.succeed(Option.none()),
  reconfigure: () => Effect.void,
});

const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

/**
 * The hub's memory engine (ADR 028): the bundled `ai-memory serve`, run as a child process on
 * loopback, restarted when it exits or stops answering, and stopped with the hub.
 */
export class MemoryEngine extends Context.Service<MemoryEngine, MemoryEngineShape>()("@hobbots/memory/MemoryEngine") {
  /** An engine that never starts, for a hub without memory: the hub and its hobs work without it. */
  static readonly off = (reason: MemoryEngineOffReason) => Layer.succeed(MemoryEngine, offEngine(reason));

  /**
   * Verifies the bundled engine, then runs it for as long as the layer's scope is open. A binary
   * that is missing or fails its checksum turns memory off, never the hub.
   */
  static readonly layer = (options: MemoryEngineOptions) =>
    Layer.effect(
      MemoryEngine,
      Effect.gen(function* () {
        const binary = yield* verifyEngine(options.folder);
        if (binary._tag !== "Verified") {
          yield* Effect.logWarning(`Memory is off: ${binary.detail}`);
          return offEngine(binary._tag === "Missing" ? "missing" : "checksum");
        }
        return yield* run(options);
      }),
    );
}

const run = (options: MemoryEngineOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    const memoryDir = join(options.dataDir, "memory");
    const configFile = join(memoryDir, "config.toml");

    const startTimeout = Duration.fromInputUnsafe(options.startTimeout ?? "30 seconds");
    const stableAfter = Duration.toMillis(Duration.fromInputUnsafe(options.stableAfter ?? "1 minute"));
    const checkEvery = options.checkEvery ?? "5 seconds";
    const settings = yield* Ref.make(options.settings ?? NO_MODEL);
    const status = yield* Ref.make<Status>({
      state: "starting",
      offReason: null,
      restarts: 0,
      lastExit: null,
      runningSince: null,
      endpoint: Option.none(),
    });
    // Completed to end the current run at once, so the next start reads the new settings.
    let restartNow = Deferred.makeUnsafe<void>();

    const answers = (url: string) =>
      http.get(`${url}/healthz`).pipe(
        Effect.map((response) => response.status === 200),
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => false),
      );

    const writeConfig = Effect.gen(function* () {
      const text = renderEngineConfig(yield* Ref.get(settings));
      // The rendered config never holds one; this guards against a future setting that would.
      if (configHoldsCredential(text, options.keys))
        return yield* Effect.die("The memory engine's config held a credential");
      yield* Effect.try({
        try: () => {
          mkdirSync(memoryDir, { recursive: true });
          writeFileSync(configFile, text, { mode: 0o600 });
        },
        catch: (cause) => new EngineLaunchFailed({ cause }),
      });
    });

    /**
     * The binary is checked again before every start, not only the first: one replaced or damaged
     * while the hub runs must never be started with the bearers. A failed check turns memory off.
     */
    const checkBinary = Effect.gen(function* () {
      const checked = yield* verifyEngine(options.folder);
      if (checked._tag === "Verified") return checked.path;
      const reason: MemoryEngineOffReason = checked._tag === "Missing" ? "missing" : "checksum";
      yield* Ref.update(status, (current) => ({
        ...current,
        state: "off" as const,
        offReason: reason,
        runningSince: null,
        endpoint: Option.none(),
      }));
      yield* Effect.logWarning(`Memory is off: ${checked.detail}`);
      return yield* new EngineTurnedOff({ reason });
    });

    /** One start of the engine, until it exits, stops answering or is asked to restart. */
    const runOnce = Effect.scoped(
      Effect.gen(function* () {
        // A restart asked for before this start is answered by it: it reads the settings anew.
        restartNow = Deferred.makeUnsafe<void>();
        const binary = yield* checkBinary;
        yield* writeConfig;
        const port = yield* freePort.pipe(Effect.mapError((cause) => new EngineLaunchFailed({ cause })));
        const url = `http://127.0.0.1:${port}`;
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(binary, [...engineArguments(port, memoryDir, configFile)], {
              cwd: memoryDir,
              env: engineEnvironment(options.keys, memoryDir),
              extendEnv: false,
              stdin: "ignore",
              forceKillAfter: "5 seconds",
            }),
          )
          .pipe(Effect.mapError((cause) => new EngineLaunchFailed({ cause })));
        // The engine logs to its data folder too; the last lines name why a start failed.
        const lastLines: Array<string> = [];
        yield* handle.all.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              lastLines.push(line);
              if (lastLines.length > 5) lastLines.shift();
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        const exited = handle.exitCode.pipe(
          Effect.map((code): number | null => Number(code)),
          Effect.orElseSucceed(() => null),
        );

        // Starting: answers, exits, or runs out of time.
        const started = yield* Effect.raceFirst(
          answers(url).pipe(
            Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: (ok) => ok }),
            Effect.as("answered" as const),
          ),
          exited.pipe(Effect.as("exited" as const)),
        ).pipe(Effect.timeoutOption(startTimeout), Effect.map(Option.getOrElse(() => "timedOut" as const)));

        const startedAt = yield* Clock.currentTimeMillis;
        let ending: "exited" | "hung" | "asked" | "timedOut" = started === "answered" ? "exited" : started;
        let code: number | null = null;
        if (started === "answered") {
          const since = new Date(startedAt).toISOString();
          yield* Ref.update(status, (current) => ({
            ...current,
            state: "running" as const,
            runningSince: since,
            endpoint: Option.some({ url, root: options.keys.root, proxy: options.keys.proxy }),
          }));
          yield* Effect.log(`Memory engine ${AI_MEMORY_VERSION} answers`);
          // Running: until it exits, misses checks in a row, or a restart is asked for.
          const hung = Effect.gen(function* () {
            let misses = 0;
            while (misses < MISSED_CHECKS) {
              yield* Effect.sleep(checkEvery);
              misses = (yield* answers(url)) ? 0 : misses + 1;
            }
            return "hung" as const;
          });
          ending = yield* Effect.raceAll([
            exited.pipe(Effect.as("exited" as const)),
            hung,
            Deferred.await(restartNow).pipe(Effect.as("asked" as const)),
          ]);
        } else if (started === "exited") {
          code = yield* exited;
        }
        if (ending === "exited" && code === null) code = yield* exited;
        const at = yield* now;
        const stable = (yield* Clock.currentTimeMillis) - startedAt >= stableAfter;
        yield* Ref.update(status, (current) => ({
          ...current,
          state: "restarting" as const,
          runningSince: null,
          endpoint: Option.none(),
          restarts: current.restarts + 1,
          lastExit: ending === "asked" ? current.lastExit : { code: ending === "exited" ? code : null, at },
        }));
        if (ending !== "asked") {
          const why =
            ending === "exited"
              ? `exited with code ${code ?? "none"}`
              : ending === "hung"
                ? "stopped answering"
                : "did not answer in time";
          yield* Effect.logWarning(`Memory engine ${why}; starting it again. ${lastLines.join(" | ")}`.trim());
        }
        // Leaving the scope stops the process: SIGTERM, then SIGKILL after five seconds.
        return yield* new EngineRunEnded({ stable: stable || ending === "asked" });
      }),
    );

    const backoff = Schedule.min([
      Schedule.exponential(options.firstBackoff ?? "500 millis"),
      Schedule.spaced(options.maxBackoff ?? "30 seconds"),
    ]);
    // A failed or short run restarts with the growing backoff; a stable one, or a requested
    // restart, starts again at once with the backoff reset.
    // A start that could not launch counts as a short run, so it is tried again with the backoff.
    const launchFailed = (failed: EngineLaunchFailed) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* Ref.update(status, (current) => ({
          ...current,
          state: "restarting" as const,
          restarts: current.restarts + 1,
          lastExit: { code: null, at },
        }));
        yield* Effect.logWarning(`Memory engine could not start; trying again. ${String(failed.cause)}`);
        return yield* new EngineRunEnded({ stable: false });
      });
    // A binary that fails its check ends supervision: memory stays off until the hub starts again.
    const supervise = runOnce.pipe(
      Effect.catchTag("EngineLaunchFailed", launchFailed),
      Effect.catchTag("EngineRunEnded", (ended) => (ended.stable ? Effect.void : Effect.fail(ended))),
      Effect.retry({ schedule: backoff, while: (error) => error._tag === "EngineRunEnded" }),
      Effect.forever,
      Effect.catchTag("EngineTurnedOff", () => Effect.void),
    );
    yield* Effect.forkScoped(supervise);

    return MemoryEngine.of({
      health: Effect.map(Ref.get(status), (current) => ({
        state: current.state,
        offReason: current.offReason,
        version: AI_MEMORY_VERSION,
        restarts: current.restarts,
        lastExit: current.lastExit,
        runningSince: current.runningSince,
      })),
      endpoint: Effect.map(Ref.get(status), (current) => current.endpoint),
      reconfigure: (next) =>
        Effect.gen(function* () {
          const before = renderEngineConfig(yield* Ref.get(settings));
          // Rendering first refuses a setting that is not a plain name before anything changes.
          if (renderEngineConfig(next) === before) return;
          yield* Ref.set(settings, next);
          yield* Deferred.succeed(restartNow, undefined);
        }),
    });
  });

/** The config file the engine last started with, for tests and backups. */
export const readEngineConfig = (dataDir: string) => readFileSync(join(dataDir, "memory", "config.toml"), "utf8");
