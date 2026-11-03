import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Effect } from "effect";
import { binaryVersions, isAtLeast, isExecutable } from "../binary.ts";

/** The Codex release ADR 024 was verified with. An older one shows as outdated; a newer one runs. */
export const minimumCodexVersion = "0.166.0";

// Where Codex's installers (npm, Homebrew) put it. An app opened from Finder gets a bare PATH, so
// these are searched before PATH and added to Codex's own PATH, where an npm install finds `node`.
const systemDirs: ReadonlyArray<string> = ["/opt/homebrew/bin", "/usr/local/bin"];

/** npm's global folder, when the user moved it from the default. */
const npmPrefixDirs = (env: NodeJS.ProcessEnv, home: string) => {
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  return [
    ...(prefix && isAbsolute(prefix) ? [join(prefix, "bin")] : []),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
  ];
};

const installDirs = (env: NodeJS.ProcessEnv, home: string, system = systemDirs) => [
  ...npmPrefixDirs(env, home),
  ...system,
];

// Relative entries would resolve against the server's working folder.
const pathDirs = (env: NodeJS.ProcessEnv) => (env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));

/** Where to look for the host's Codex, in order (macOS and Linux). */
export const codexCandidates = (env: NodeJS.ProcessEnv, home: string, system = systemDirs): ReadonlyArray<string> =>
  [...new Set([...installDirs(env, home, system), ...pathDirs(env)])].map((dir) => join(dir, "codex"));

/** PATH for Codex: its own folder first, so an npm install finds the `node` beside it. */
export const codexPath = (binary: string, env: NodeJS.ProcessEnv, home: string): string =>
  [...new Set([dirname(binary), ...installDirs(env, home), ...pathDirs(env)])].join(delimiter);

/** The environment Codex runs with outside the sandbox: the hub's own, with Codex's PATH. */
export const codexEnv = (binary: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()) => ({
  ...env,
  PATH: codexPath(binary, env, home),
});

/**
 * The configured binary, or the first executable candidate on this machine. A relative path is
 * resolved against the hub's working folder; a bare name stays a PATH lookup.
 */
export const findCodex = (
  executable: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  system = systemDirs,
): string | undefined => {
  const configured = executable?.trim();
  if (configured) return configured.includes(sep) ? resolve(configured) : configured;
  return codexCandidates(env, home, system).find(isExecutable);
};

/** The `major.minor.patch` in `codex --version`, which prints `codex-cli 0.166.0`. */
export const parseCodexVersion = (output: string): string | undefined =>
  /^\s*codex(?:-cli)?\s+v?(\d+\.\d+\.\d+)/m.exec(output)?.[1];

export type LocatedCodex =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Broken"; readonly binary: string }
  | { readonly _tag: "Outdated"; readonly binary: string; readonly version: string }
  | { readonly _tag: "Found"; readonly binary: string; readonly version: string };

/**
 * Finds Codex and checks its version on every call, so installing, moving or updating Codex needs
 * no restart. `codex --version` runs again only when the binary changes.
 */
export const codexLocator = (executable: string | undefined) => {
  const versionOf = binaryVersions(parseCodexVersion, (binary) => codexEnv(binary));
  return Effect.gen(function* () {
    const binary = findCodex(executable);
    if (binary === undefined) return { _tag: "Missing" } as LocatedCodex;
    const version = yield* versionOf(binary);
    if (version === undefined) return { _tag: "Broken", binary } as LocatedCodex;
    if (!isAtLeast(version, minimumCodexVersion)) return { _tag: "Outdated", binary, version } as LocatedCodex;
    return { _tag: "Found", binary, version } as LocatedCodex;
  });
};
