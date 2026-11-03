import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RuntimeHealth, RuntimeModels } from "@hobbots/domain";
import { Clock, DateTime, Duration, Effect } from "effect";

const execFileAsync = promisify(execFile);

/** Whether `path` is a file this process may run. */
export const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Whether `version` (`major.minor.patch`) is `minimum` or later. */
export const isAtLeast = (version: string, minimum: string): boolean => {
  const [a, b] = [version, minimum].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const diff = (a?.[i] ?? 0) - (b?.[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
};

/**
 * Asks a runtime's binary for its version with `--version`, once per binary until the file
 * changes, as an update does. Undefined when the binary cannot run or prints no version.
 */
const binaryVersions = (parse: (output: string) => string | undefined, env: (binary: string) => NodeJS.ProcessEnv) => {
  const versions = new Map<string, { readonly modified: number; readonly version: string }>();
  return (binary: string) =>
    Effect.gen(function* () {
      // A configured path may not exist, and an update can remove the binary between lookups.
      const modified = yield* Effect.try(() => statSync(binary).mtimeMs).pipe(Effect.orElseSucceed(() => -1));
      const cached = versions.get(binary);
      if (cached !== undefined && cached.modified === modified) return cached.version;
      const output = yield* Effect.tryPromise(() =>
        execFileAsync(binary, ["--version"], { timeout: 10_000, env: env(binary) }).then((result) => result.stdout),
      ).pipe(Effect.orElseSucceed(() => ""));
      const version = parse(output);
      if (version !== undefined) versions.set(binary, { modified, version });
      return version;
    });
};

/**
 * The configured binary, or the first executable candidate on this machine. A relative path is
 * resolved against the hub's working folder; a bare name stays a PATH lookup.
 */
export const findBinary = (
  executable: string | undefined,
  candidates: () => ReadonlyArray<string>,
): string | undefined => {
  const configured = executable?.trim();
  if (configured) return configured.includes(sep) ? resolve(configured) : configured;
  return candidates().find(isExecutable);
};

/** Where a runtime's binary is, and whether its version is one Hobbots runs. */
export type LocatedBinary =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Broken"; readonly binary: string }
  | { readonly _tag: "Outdated"; readonly binary: string; readonly version: string }
  | { readonly _tag: "Found"; readonly binary: string; readonly version: string };

/**
 * Finds a runtime's binary and checks its version on every run, so installing, moving or updating
 * it needs no restart. `--version` runs again only when the binary changes.
 */
export const binaryLocator = (options: {
  readonly find: () => string | undefined;
  readonly parse: (output: string) => string | undefined;
  readonly env: (binary: string) => NodeJS.ProcessEnv;
  readonly minimum: string;
}): Effect.Effect<LocatedBinary> => {
  const versionOf = binaryVersions(options.parse, options.env);
  return Effect.gen(function* () {
    const binary = options.find();
    if (binary === undefined) return { _tag: "Missing" } as const;
    const version = yield* versionOf(binary);
    if (version === undefined) return { _tag: "Broken", binary } as const;
    if (!isAtLeast(version, options.minimum)) return { _tag: "Outdated", binary, version } as const;
    return { _tag: "Found", binary, version } as const;
  });
};

/** What provider health says about a runtime that was not found ready to start. */
export interface NotFoundHealth {
  readonly availability: "unavailable" | "outdated";
  readonly version: string | null;
  readonly detail: string;
  readonly checkedAt: string;
}

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

/**
 * A runtime's health and model list from its installed binary: how to fix one that is missing,
 * broken or outdated, and what the found binary answers itself. Each binary's model list is kept
 * while `modelListMaxAge` trusts it.
 */
export const installedRuntimeChecks = (options: {
  readonly locate: Effect.Effect<LocatedBinary>;
  readonly words: {
    readonly name: string;
    readonly install: string;
    readonly notStarted: string;
    readonly outdated: string;
  };
  readonly notFound: (health: NotFoundHealth) => RuntimeHealth;
  readonly probe: (binary: string, version: string, checkedAt: string) => Effect.Effect<RuntimeHealth>;
  readonly fallbackModels: RuntimeModels;
  readonly listModels: (binary: string) => Effect.Effect<RuntimeModels, unknown>;
}) => {
  const { words, notFound } = options;
  const health = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const located = yield* options.locate;
    switch (located._tag) {
      case "Missing":
        return notFound({ availability: "unavailable", version: null, detail: words.install, checkedAt });
      case "Broken":
        return notFound({
          availability: "unavailable",
          version: null,
          detail: `${located.binary} did not report a ${words.name} version. ${words.notStarted}`,
          checkedAt,
        });
      case "Outdated":
        return notFound({ availability: "outdated", version: located.version, detail: words.outdated, checkedAt });
      case "Found":
        return yield* options.probe(located.binary, located.version, checkedAt);
    }
  });
  const cache = expiringCache(modelListMaxAge);
  const models = Effect.gen(function* () {
    const located = yield* options.locate;
    if (located._tag !== "Found") return options.fallbackModels;
    return yield* cache(
      `${located.binary}@${located.version}`,
      options.listModels(located.binary).pipe(Effect.orElseSucceed(() => options.fallbackModels)),
    );
  });
  return { health, models };
};
