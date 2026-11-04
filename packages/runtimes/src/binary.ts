import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RuntimeError } from "@hobbots/agents";
import {
  type PlanUsage,
  type RuntimeHealth,
  type RuntimeKind,
  type RuntimeModels,
  unreportedPlan,
} from "@hobbots/domain";
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

/** The file a binary runs: the binary itself when it is a path, or a bare name's first match on PATH. */
const binaryFile = (binary: string, path: string | undefined): string | undefined =>
  binary.includes(sep)
    ? binary
    : (path ?? "")
        .split(delimiter)
        .filter((folder) => folder !== "")
        .map((folder) => join(folder, binary))
        .find(isExecutable);

/** When the file a binary runs last changed, or undefined when that file cannot be found. */
const modifiedAt = (binary: string, path: string | undefined): number | undefined => {
  const file = binaryFile(binary, path);
  if (file === undefined) return undefined;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Asks a runtime's binary for its version with `--version`, once per binary until the file
 * changes, as an update does. Undefined when the binary cannot run or prints no version. A binary
 * whose file cannot be found, so an update could not be noticed, is asked every time.
 */
const binaryVersions = (parse: (output: string) => string | undefined, env: (binary: string) => NodeJS.ProcessEnv) => {
  const versions = new Map<string, { readonly modified: number; readonly version: string }>();
  return (binary: string) =>
    Effect.gen(function* () {
      const binaryEnv = env(binary);
      // A configured path may not exist, and an update can remove the binary between lookups.
      const modified = modifiedAt(binary, binaryEnv.PATH);
      const cached = versions.get(binary);
      if (cached !== undefined && cached.modified === modified) return cached.version;
      const output = yield* Effect.tryPromise(() =>
        execFileAsync(binary, ["--version"], { timeout: 10_000, env: binaryEnv }).then((result) => result.stdout),
      ).pipe(Effect.orElseSucceed(() => ""));
      const version = parse(output);
      if (version !== undefined && modified !== undefined) versions.set(binary, { modified, version });
      else versions.delete(binary);
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

/** What a runtime's messages call it and how to install or update it. */
export interface RuntimeWords {
  readonly name: string;
  readonly install: string;
  readonly notStarted: string;
  readonly outdated: string;
}

/** The binary a turn runs, or why it cannot run: only one health would show as ready to start. */
export const runnableBinary = (
  locate: Effect.Effect<LocatedBinary>,
  words: RuntimeWords,
): Effect.Effect<string, RuntimeError> =>
  Effect.gen(function* () {
    const located = yield* locate;
    switch (located._tag) {
      case "Found":
        return located.binary;
      case "Missing":
        return yield* new RuntimeError({ message: `${words.name} was not found. ${words.install}` });
      case "Broken":
        return yield* new RuntimeError({ message: words.notStarted });
      case "Outdated":
        return yield* new RuntimeError({ message: `${words.name} ${located.version} is too old. ${words.outdated}` });
    }
  });

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

/** How long a runtime's plan is kept before it is asked again. */
const planMaxAge = Duration.minutes(1);

/**
 * A runtime's plan from its installed binary, kept a minute per binary and version. A runtime that
 * is not found, or a read that fails, reports nothing.
 */
export const installedPlanUsage = <E>(options: {
  readonly runtime: RuntimeKind;
  readonly locate: Effect.Effect<LocatedBinary>;
  readonly read: (binary: string, checkedAt: string) => Effect.Effect<PlanUsage, E>;
}): Effect.Effect<PlanUsage> => {
  const cache = expiringCache<PlanUsage>(() => planMaxAge);
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const located = yield* options.locate;
    if (located._tag !== "Found") return unreportedPlan(options.runtime, checkedAt);
    return yield* cache(
      `${located.binary}@${located.version}`,
      options
        .read(located.binary, checkedAt)
        .pipe(Effect.orElseSucceed(() => unreportedPlan(options.runtime, checkedAt))),
    );
  });
};

/**
 * A runtime's health and model list from its installed binary: how to fix one that is missing,
 * broken or outdated, and what the found binary answers itself. Each binary's model list is kept
 * while `modelListMaxAge` trusts it.
 */
export const installedRuntimeChecks = (options: {
  readonly locate: Effect.Effect<LocatedBinary>;
  readonly words: RuntimeWords;
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
