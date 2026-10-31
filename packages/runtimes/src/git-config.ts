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

// Parts of key names that hold credentials, such as `http.extraHeader = Authorization: Bearer …`.
const SECRET_KEY_PARTS = ["token", "password", "passwd", "secret", "extraheader", "authorization", "apikey", "api-key"];
// Token shapes that can sit anywhere: GitHub, GitLab and Slack tokens, AWS access keys.
const TOKEN_SHAPE =
  /\b(?:gh[pousr]_[A-Za-z\d]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[A-Z\d]{16})\b/;

// Plain string scans rather than backtracking patterns, since the files are the user's to shape.
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\r";

/** A line without its comment: `#` or `;` at its start or after a space. */
const withoutComment = (line: string) => {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && (c === "#" || c === ";") && (i === 0 || isSpace(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};

/** A `key = value` line's key, lowercased, or null for a section header or a line without one. */
const keyOf = (line: string) => {
  const eq = line.indexOf("=");
  return eq === -1 || line.trimStart().startsWith("[") ? null : line.slice(0, eq).trim().toLowerCase();
};

/** Whether a line holds a URL with a password, such as `https://user:token@github.com/`. */
const hasUrlPassword = (line: string) => {
  let from = 0;
  for (;;) {
    const at = line.indexOf("://", from);
    if (at === -1) return false;
    let end = at + 3;
    while (end < line.length && !isSpace(line[end]) && line[end] !== "/" && line[end] !== '"') end++;
    const authority = line.slice(at + 3, end);
    const userinfo = authority.lastIndexOf("@");
    if (userinfo > 0 && authority.slice(0, userinfo).includes(":")) return true;
    from = end;
  }
};

/** Why a config file's text looks like it holds a secret, or null when it does not. */
export const secretIn = (text: string): string | null => {
  const lines = text.split("\n").map(withoutComment);
  if (lines.some((line) => SECRET_KEY_PARTS.some((part) => keyOf(line)?.includes(part))))
    return "it sets a token, password or authorization header";
  if (lines.some(hasUrlPassword)) return "it holds a URL with a password";
  if (lines.some((line) => TOKEN_SHAPE.test(line))) return "it holds what looks like an access token";
  return null;
};

const unquote = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : withoutComment(trimmed).trim();
};

/** A section header's name, lowercased, such as `includeif` for `[includeIf "gitdir:~/work/"]`. */
const sectionOf = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  let end = 1;
  while (end < trimmed.length && !isSpace(trimmed[end]) && trimmed[end] !== "]" && trimmed[end] !== '"') end++;
  return trimmed.slice(1, end).toLowerCase();
};

/**
 * The files a config includes through `include.path` or `includeIf.<condition>.path`, absolute.
 * Conditions are not evaluated: any of them may apply in some repository, so all count.
 */
export const includedFiles = (text: string, file: string, home: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  let inInclude = false;
  for (const line of text.split("\n")) {
    const section = sectionOf(line);
    if (section !== null) {
      inInclude = section === "include" || section === "includeif";
      continue;
    }
    if (!inInclude || keyOf(line) !== "path") continue;
    const value = unquote(line.slice(line.indexOf("=") + 1));
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
