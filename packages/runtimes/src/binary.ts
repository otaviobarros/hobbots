import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { promisify } from "node:util";
import { Effect } from "effect";

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
export const binaryVersions = (
  parse: (output: string) => string | undefined,
  env: (binary: string) => NodeJS.ProcessEnv,
) => {
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
