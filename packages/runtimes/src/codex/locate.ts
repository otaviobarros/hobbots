import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { binaryLocator, findBinary } from "../binary.ts";

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

/** The configured binary, or the first executable candidate on this machine. */
export const findCodex = (
  executable: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  system = systemDirs,
): string | undefined => findBinary(executable, () => codexCandidates(env, home, system));

/** The `major.minor.patch` in `codex --version`, which prints `codex-cli 0.166.0`. */
export const parseCodexVersion = (output: string): string | undefined =>
  /^\s*codex(?:-cli)?\s+v?(\d+\.\d+\.\d+)/m.exec(output)?.[1];

/** Finds Codex and checks it is a version Hobbots runs (ADR 024). */
export const codexLocator = (executable: string | undefined) =>
  binaryLocator({
    find: () => findCodex(executable),
    parse: parseCodexVersion,
    env: (binary) => codexEnv(binary),
    minimum: minimumCodexVersion,
  });
