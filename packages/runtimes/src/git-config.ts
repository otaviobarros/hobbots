import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The user's own Git config files, which the sandbox opens for reading (ADR 014). The home folder is
 * closed, and on macOS Git stops when it cannot read `~/.gitconfig` ("Operation not permitted"), so
 * every `git` command a hob ran failed. A variable such as `GIT_CONFIG_GLOBAL` cannot point Git
 * elsewhere, because Claude Code's credential scrub removes it from the commands' environment. So the
 * files are opened read-only, with the files they include, unless any of them looks like it holds a
 * secret: then all stay closed, and Git fails as before rather than show a hob a credential.
 */

/** Which of the user's Git config files the turn may read, or why none may. */
export type GitConfigAccess =
  | { readonly _tag: "Open"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Closed"; readonly file: string; readonly reason: string };

// Keys whose values are credentials, such as `http.extraHeader = Authorization: Bearer …`.
const SECRET_KEY = /^\s*[\w.-]*(?:token|password|passwd|secret|extraheader|authorization|apikey|api-key)\s*=/im;
// A URL carrying a password, such as `url.https://user:token@github.com/.insteadOf`.
const URL_PASSWORD = /[a-z][a-z\d+.-]*:\/\/[^\s/@:"]+:[^\s/@"]+@/i;
// Token shapes that can sit anywhere: GitHub, GitLab and Slack tokens, AWS access keys.
const TOKEN_SHAPE =
  /\b(?:gh[pousr]_[A-Za-z\d]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[A-Z\d]{16})\b/;

/** Why a config file's text looks like it holds a secret, or null when it does not. */
export const secretIn = (text: string): string | null => {
  const lines = text
    .split("\n")
    .filter((line) => !/^\s*[#;]/.test(line))
    .join("\n");
  if (SECRET_KEY.test(lines)) return "it sets a token, password or authorization header";
  if (URL_PASSWORD.test(lines)) return "it holds a URL with a password";
  if (TOKEN_SHAPE.test(lines)) return "it holds what looks like an access token";
  return null;
};

const unquote = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : trimmed.replace(/\s[#;].*$/, "");
};

/**
 * The files a config includes through `include.path` or `includeIf.<condition>.path`, absolute.
 * Conditions are not evaluated: any of them may apply in some repository, so all count.
 */
export const includedFiles = (text: string, file: string, home: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  let inInclude = false;
  for (const line of text.split("\n")) {
    const section = /^\s*\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (section) {
      const name = (section[1] as string).toLowerCase();
      inInclude = name === "include" || name === "includeif";
      continue;
    }
    const path = inInclude ? /^\s*path\s*=\s*(.+)$/i.exec(line) : null;
    if (!path) continue;
    const value = unquote(path[1] as string);
    if (value === "") continue;
    if (value === "~" || value.startsWith("~/")) found.push(join(home, value.slice(1)));
    else found.push(isAbsolute(value) ? value : resolve(dirname(file), value));
  }
  return found;
};

/** Where Git looks for the user's global config: `~/.gitconfig` and the XDG one. */
export const userGitConfigFiles = (home: string, env: NodeJS.ProcessEnv): ReadonlyArray<string> => [
  join(home, ".gitconfig"),
  join(env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config"),
];

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A file's text, or null when it does not exist or cannot be read. */
export type ReadText = (path: string) => string | null;

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// More files than this are left closed, which stops a loop of includes.
const MAX_FILES = 32;

/**
 * Decides which of the user's Git config files a turn may read: those that exist, the files they
 * include and their real locations, as long as none of them looks like it holds a secret.
 */
export const gitConfigAccess = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  read: ReadText = readText,
  real: (path: string) => string = realOrSelf,
): GitConfigAccess => {
  const queue = [...userGitConfigFiles(home, env)];
  const seen = new Set<string>();
  const files: Array<string> = [];
  while (queue.length > 0 && seen.size < MAX_FILES) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = read(file);
    if (text === null) continue;
    const secret = secretIn(text);
    if (secret !== null) return { _tag: "Closed", file, reason: secret };
    files.push(file, real(file));
    queue.push(...includedFiles(text, file, home));
  }
  return { _tag: "Open", files: [...new Set(files)] };
};
