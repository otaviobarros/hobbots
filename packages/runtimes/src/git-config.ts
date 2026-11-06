import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type CommitIdentity, type CommitsAs, type GitIdentity, secretShapeIn } from "@hobbots/domain";

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

// Words that name credentials, such as `http.extraHeader = Authorization: Bearer …` or a credential
// helper written inline as `!f() { echo password=…; }; f`.
const SECRET_WORDS = ["token", "password", "passwd", "secret", "extraheader", "authorization", "apikey", "api-key"];

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

/**
 * A line without the file paths in it, such as `/Applications/1Password.app/Contents/MacOS/op-ssh-sign`
 * or `~/bin/password-store-helper`, which name programs rather than hold credentials. A path starts
 * with `/` or `~/` at the start of the line or after a space, quote or `=`, and runs to the next
 * space or quote; one holding `=` is kept, since it may be an assignment such as `password=…`.
 */
const withoutPaths = (line: string) => {
  let kept = "";
  let i = 0;
  while (i < line.length) {
    const before = line[i - 1];
    const starts =
      (line[i] === "/" || (line[i] === "~" && line[i + 1] === "/")) &&
      (i === 0 || isSpace(before) || before === '"' || before === "'" || before === "=");
    if (!starts) {
      kept += line[i];
      i++;
      continue;
    }
    let end = i;
    while (end < line.length && !isSpace(line[end]) && line[end] !== '"' && line[end] !== "'") end++;
    const path = line.slice(i, end);
    if (path.includes("=")) kept += path;
    i = end;
  }
  return kept;
};

/** A config file, read for its settings, or a list of patterns such as an ignore or attributes file. */
export type GitFileKind = "config" | "list";

/**
 * Why a file's text looks like it holds a secret, or null when it does not. The whole text is
 * scanned, comments included, since the sandbox opens the file as it is. In a config file any line
 * naming a token, password, secret or authorization header counts, in a key, a value (an inline
 * credential helper) or a comment, apart from file paths, which name programs such as 1Password's
 * signer. Pattern lists only count URL passwords and the secret shapes Hobbots redacts, since
 * entries such as `secrets/` or `*.token` are common there.
 */
export const secretIn = (text: string, kind: GitFileKind = "config"): string | null => {
  const lines = text.split("\n");
  const names = (line: string) => {
    const words = withoutPaths(line).toLowerCase();
    return SECRET_WORDS.some((word) => words.includes(word));
  };
  if (kind === "config" && lines.some(names)) return "it names a token, password, secret or authorization header";
  if (lines.some(hasUrlPassword)) return "it holds a URL with a password";
  const shape = lines.map(secretShapeIn).find((kind) => kind !== null);
  if (shape !== undefined) return `it holds what looks like a secret (${shape})`;
  return null;
};

/** A value without its comment, then without its quotes: `"config.local" # work` is `config.local`. */
const unquote = (value: string) => {
  const trimmed = withoutComment(value).trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : trimmed;
};

/** A section header's name, lowercased, such as `includeif` for `[includeIf "gitdir:~/work/"]`. */
const sectionOf = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  let end = 1;
  while (end < trimmed.length && !isSpace(trimmed[end]) && trimmed[end] !== "]" && trimmed[end] !== '"') end++;
  return trimmed.slice(1, end).toLowerCase();
};

/** A path a config names, absolute: from the home folder for `~/`, else from the config's own folder. */
const pathFrom = (value: string, file: string, home: string) =>
  value === "~" || value.startsWith("~/")
    ? join(home, value.slice(1))
    : isAbsolute(value)
      ? value
      : resolve(dirname(file), value);

/**
 * The other files a config makes Git read, absolute: those it includes through `include.path` or
 * `includeIf.<condition>.path`, and the ignore and attributes files `core.excludesFile` and
 * `core.attributesFile` name. Conditions are not evaluated: any of them may apply in some
 * repository, so all count.
 */
export const includedFiles = (
  text: string,
  file: string,
  home: string,
): ReadonlyArray<{ readonly file: string; readonly kind: GitFileKind }> => {
  const found: Array<{ file: string; kind: GitFileKind }> = [];
  let section: string | null = null;
  for (const line of text.split("\n")) {
    section = sectionOf(line) ?? section;
    const key = keyOf(line);
    const kind: GitFileKind | null =
      (section === "include" || section === "includeif") && key === "path"
        ? "config"
        : section === "core" && (key === "excludesfile" || key === "attributesfile")
          ? "list"
          : null;
    if (kind === null) continue;
    const value = unquote(line.slice(line.indexOf("=") + 1));
    if (value === "") continue;
    found.push({ file: pathFrom(value, file, home), kind });
  }
  return found;
};

/** Where Git looks for the user's own files: `~/.gitconfig` and the XDG config, ignore and attributes. */
export const userGitConfigFiles = (
  home: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<{ readonly file: string; readonly kind: GitFileKind }> => {
  const xdg = join(env.XDG_CONFIG_HOME || join(home, ".config"), "git");
  return [
    { file: join(home, ".gitconfig"), kind: "config" },
    { file: join(xdg, "config"), kind: "config" },
    { file: join(xdg, "ignore"), kind: "list" },
    { file: join(xdg, "attributes"), kind: "list" },
  ];
};

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
    const { file, kind } = queue.shift() as { file: string; kind: GitFileKind };
    // A file named both ways is scanned both ways.
    if (seen.has(`${kind}:${file}`)) continue;
    seen.add(`${kind}:${file}`);
    const text = read(file);
    if (text === null) continue;
    const secret = secretIn(text, kind);
    if (secret !== null) return { _tag: "Closed", file, reason: secret };
    files.push(file, real(file));
    if (kind === "config") queue.push(...includedFiles(text, file, home));
  }
  return { _tag: "Open", files: [...new Set(files)] };
};

/** The identity `files` set, read as Git reads them, following unconditional includes. */
const identityIn = (files: ReadonlyArray<string>, home: string, read: ReadText): GitIdentity => {
  const identity: { name: string | null; email: string | null } = { name: null, email: null };
  const seen = new Set<string>();
  const visit = (file: string) => {
    const text = seen.has(file) || seen.size >= MAX_FILES ? null : read(file);
    seen.add(file);
    if (text === null) return;
    let section: string | null = null;
    for (const line of text.split("\n")) {
      section = sectionOf(line) ?? section;
      const key = keyOf(line);
      if (key === null) continue;
      const value = unquote(line.slice(line.indexOf("=") + 1));
      if (section === "user" && (key === "name" || key === "email")) identity[key] = value === "" ? null : value;
      else if (section === "include" && key === "path" && value !== "") visit(pathFrom(value, file, home));
    }
  };
  for (const file of files) visit(file);
  return identity;
};

/**
 * The identity the user's own Git config sets (#586): `user.name` and `user.email` from
 * `~/.gitconfig`, the XDG config and the files they include unconditionally, the last setting
 * winning as in Git. `includeIf` files are left out, since their conditions depend on the
 * repository. Only these two settings are read, so a file that also holds a secret still gives them.
 */
export const userGitIdentity = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  read: ReadText = readText,
): GitIdentity =>
  identityIn(
    userGitConfigFiles(home, env).flatMap(({ file, kind }) => (kind === "config" ? [file] : [])),
    home,
    read,
  );

/** Adds Git settings to an environment through `GIT_CONFIG_COUNT`, keeping the settings already there. */
const withGitSettings = (env: NodeJS.ProcessEnv, settings: ReadonlyArray<readonly [string, string]>) => {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const added: Record<string, string> = { GIT_CONFIG_COUNT: String(count + settings.length) };
  for (const [index, [key, value]] of settings.entries()) {
    added[`GIT_CONFIG_KEY_${count + index}`] = key;
    added[`GIT_CONFIG_VALUE_${count + index}`] = value;
  }
  return { ...env, ...added };
};

/**
 * The environment a hob's commands commit with when no app identity applies (#586). Git would
 * otherwise make an email up from the user's account and the computer's name when no config gives
 * one, as in a sandbox that cannot read the user's config.
 *
 * - The user's email goes in `EMAIL`, below every config, so a repository's own `user.email` wins.
 * - No name is given. Git takes it from config: the repository's own `user.name`, or else the user's
 *   global one, which the sandbox opens for reading (`gitConfigAccess`). Git has no place for a name
 *   below a repository's config that a command's environment can reach, since Claude Code's scrub
 *   removes `GIT_CONFIG_GLOBAL`, and `GIT_AUTHOR_NAME` or a command-level `user.name` would override
 *   every repository's own. Where neither config sets one, as when the user's config stays closed,
 *   Git takes the account's full name, and fails when that is empty.
 * - With no email in the user's config, the identity the user gave Hobbots (`given`, #741) is used:
 *   its email in `EMAIL`, and its name as `user.name` when the user's config sets no name either.
 *   That name then wins over a repository's own, which is the price of a user with no Git identity.
 * - With neither, Git is told to take an email from config only, so a commit without one fails
 *   rather than go out under a made-up address.
 *
 * Settings already in `GIT_CONFIG_COUNT` are kept.
 */
export const withUserIdentity = (
  env: NodeJS.ProcessEnv,
  identity: GitIdentity,
  given: CommitIdentity | null = null,
): NodeJS.ProcessEnv => {
  if (identity.email !== null) return { ...env, EMAIL: identity.email };
  if (given === null) return withGitSettings(env, [["user.useConfigOnly", "true"]]);
  const named = identity.name === null ? withGitSettings(env, [["user.name", given.name]]) : env;
  return { ...named, EMAIL: given.email };
};

/**
 * What a hob is told when no identity applies to its commits (#741). It can set none, and Hobbots
 * asks the user itself, so asking again in chat only goes round in circles.
 */
export const NO_GIT_IDENTITY_NOTE = [
  "No Git identity is set for your commits yet: the user's Git config sets none, and Hobbots is asking the user who hobs should commit as.",
  "Do not ask the user yourself and never set an identity: Hobbots applies their answer to your next turn.",
  "Until then, do not commit. Do the rest of the work, leave your changes uncommitted, and say in your reply that the commit waits for the user to answer Hobbots' question about who hobs commit as.",
].join(" ");

/** What a hob is told when it commits under the identity the user gave Hobbots (#741). */
export const givenIdentityNote = (identity: CommitIdentity) =>
  `Your commits are made as ${identity.name} <${identity.email}>, the identity the user gave Hobbots, since their Git config sets none.`;

/**
 * What every runtime does with who a turn's commits are made as (#586, #741), so that each one
 * applies it the same way: the environment its commands get, the note its instructions carry, and
 * the line said again in every resumed session's prompt. A runtime adapter applies all three.
 */
export interface TurnCommits {
  /** What the system prompt says of it, when there is more to say than the bot note. */
  readonly note: string;
  /**
   * Who the turn's commits are made as, said again in every resumed session's prompt, since a
   * session keeps the system prompt it started with: one started with no identity would otherwise
   * keep "do not commit" after the user answers (#741). Empty for a turn without tools.
   */
  readonly now: string;
  /** The environment the turn's commands commit with, from the one they would get. */
  readonly env: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/** Who a turn's commits are made as, in one line, whichever it is. */
export const commitIdentityNow = (as: CommitsAs): string => {
  switch (as._tag) {
    case "Missing":
      return NO_GIT_IDENTITY_NOTE;
    case "UserGiven":
      return givenIdentityNote(as.identity);
    case "UserConfig":
      return "Your commits are made as the user, with the identity their Git config sets.";
    case "Bot":
      return `Your commits are made as ${as.identity.name} <${as.identity.email}>, the bot of your own GitHub App.`;
  }
};

/** The environment a turn's commands commit with. The bot's identity is set where the runtime starts (ADR 022). */
const commitEnv =
  (as: CommitsAs) =>
  (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    switch (as._tag) {
      case "Bot":
        return env;
      case "UserConfig":
      case "Missing":
        return withUserIdentity(env, as.config);
      case "UserGiven":
        return withUserIdentity(env, as.config, as.identity);
    }
  };

/**
 * How a turn's commands commit and what its hob is told, from who the hub settled its commits are
 * made as (`commitsAs`); nothing for a turn without tools. The runtime reads no Git config itself.
 */
export const turnCommits = (tools: { readonly commitsAs: CommitsAs } | null): TurnCommits => {
  if (tools === null) return { note: "", now: "", env: (env) => env };
  const as = tools.commitsAs;
  const note =
    as._tag === "Missing" ? NO_GIT_IDENTITY_NOTE : as._tag === "UserGiven" ? givenIdentityNote(as.identity) : "";
  return { note, now: commitIdentityNow(as), env: commitEnv(as) };
};
