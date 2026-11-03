import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { secretShapeIn } from "@hobbots/domain";

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

/** The name and email the user's own Git config sets, either of which may be missing. */
export interface GitIdentity {
  readonly name: string | null;
  readonly email: string | null;
}

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

/** The config files of the repository holding `folder`: its own, a worktree's, and the shared one. */
const repositoryConfigs = (folder: string, read: ReadText): ReadonlyArray<string> => {
  for (let at = folder; ; at = dirname(at)) {
    const dotGit = join(at, ".git");
    if (read(join(dotGit, "config")) !== null) return [join(dotGit, "config"), join(dotGit, "config.worktree")];
    const line = (read(dotGit) ?? "").split("\n")[0]?.trim() ?? "";
    if (line.startsWith("gitdir:")) {
      const gitdir = resolve(at, line.slice("gitdir:".length).trim());
      const common = (read(join(gitdir, "commondir")) ?? "").trim();
      const shared = common === "" ? gitdir : resolve(gitdir, common);
      return [join(shared, "config"), join(gitdir, "config.worktree")];
    }
    if (dirname(at) === at) return [];
  }
};

/**
 * Whether a repository holding one of `folders` sets its own `user.name` or `user.email`, which
 * then stays its own: the user's name is given to Git only where no repository names its own.
 */
export const repositoryNamesItself = (
  folders: ReadonlyArray<string>,
  home: string,
  read: ReadText = readText,
): boolean =>
  folders.some((folder) => {
    const own = identityIn(repositoryConfigs(folder, read), home, read);
    return own.name !== null || own.email !== null;
  });

/**
 * The environment a hob's commands commit with when no app identity applies (#586). Git would
 * otherwise make an identity up from the user's account and the computer's name when it finds none,
 * as a sandbox that cannot read the user's config does.
 *
 * - The user's email goes in `EMAIL`, below every config, so a repository's own `user.email` wins.
 * - Git has no such place for a name, so the user's name goes in `GIT_AUTHOR_NAME` and
 *   `GIT_COMMITTER_NAME`, which win over config, only when no repository of the turn's folders
 *   names itself (`ownName`). Such a repository keeps its own name and email.
 * - With no email, Git is told to take an identity from config only, so a commit without one
 *   fails, and the hob asks.
 *
 * Settings already in `GIT_CONFIG_COUNT` are kept.
 */
export const withUserIdentity = (env: NodeJS.ProcessEnv, identity: GitIdentity, ownName = false): NodeJS.ProcessEnv => {
  if (identity.email !== null) {
    const named =
      identity.name === null || ownName ? {} : { GIT_AUTHOR_NAME: identity.name, GIT_COMMITTER_NAME: identity.name };
    return { ...env, EMAIL: identity.email, ...named };
  }
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "user.useConfigOnly",
    [`GIT_CONFIG_VALUE_${count}`]: "true",
  };
};

/** What a hob is told when no identity applies to its commits (#586). */
export const NO_GIT_IDENTITY_NOTE =
  "No Git identity is set for your commits: neither yours nor the user's. Ask the user who to commit as before you commit, and never set one yourself.";

/** How a turn's commands commit, and what its hob is told about it. */
export interface UserCommits {
  readonly note: string;
  readonly env: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/**
 * The user's identity for a turn with tools, whose commands in its folders may commit, when its hob
 * has no app of its own to commit as (`commitAs`), read from the user's config and the folders'
 * repositories now. Anything else commits as it would.
 */
export const userCommits = (
  tools: {
    readonly folders: ReadonlyArray<string>;
    readonly commitAs?: { readonly name: string; readonly email: string };
  } | null,
  home: string = homedir(),
): UserCommits => {
  if (tools === null || tools.commitAs !== undefined) return { note: "", env: (env) => env };
  const identity = userGitIdentity(home);
  const ownName = repositoryNamesItself(tools.folders, home);
  return {
    note: identity.email === null ? NO_GIT_IDENTITY_NOTE : "",
    env: (env) => withUserIdentity(env, identity, ownName),
  };
};
