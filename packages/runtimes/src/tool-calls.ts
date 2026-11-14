import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { type CommandStart, operationDecision } from "@hobbots/agents";
import { narrowest, openTools, redactSecrets } from "@hobbots/domain";
import {
  type PolicyContext,
  type PolicyRequest,
  type PolicyVerdict,
  readCommandLine,
  uniqueRules,
} from "@hobbots/permissions";
import { GIT_IDENTITY_VARIABLES } from "./sandbox.ts";

/** A request a runtime tool call becomes: every kind but a Charm's, which the hub makes itself. */
type ToolRequest = Exclude<PolicyRequest, { readonly _tag: "Charm" | "Memory" | "Skills" | "Directory" }>;

/** A request a command line makes: anything on the hub or the network, never a runtime's search. */
type CommandRequest = Exclude<ToolRequest, { readonly _tag: "Search" }>;

/**
 * Claude Code's tool calls in the policy engine's terms (ADR 014). Only what the call itself says is
 * used, never the model's account of it. A tool this module does not know is refused, so a new
 * runtime tool stays closed until it is mapped here.
 */

/** The built-in tools a hob gets, each normalized below. */
export const CLAUDE_CODE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
] as const;

/**
 * Claude Code's own web search (ADR 036), decided as Search the web and offered only when the hub
 * settled that the turn may search. Its `WebFetch` is never offered: it summarizes a page with a
 * second model, so the hub would not see what the hob read, and a call to it is refused as unknown.
 */
export const WEB_SEARCH_TOOL = "WebSearch";

/**
 * The tools offered to the runtime this turn. A tool whose operations are all denied is left out,
 * so the model does not try it. Bash also needs the sandbox, and since a command reads and writes
 * the folders without asking file by file, it is offered only when the hob may read them without
 * asking and either edit them without asking or not at all, when its commands are read-only (see
 * `openTools`). Every call is still decided one by one.
 */
export const offeredTools = (context: Pick<PolicyContext, "preset" | "hob" | "restrictions" | "sandbox">) => {
  const open = openTools((operation) => operationDecision(context, operation));
  return CLAUDE_CODE_TOOLS.filter((tool) => {
    switch (tool) {
      case "Read":
      case "Glob":
      case "Grep":
        return open.read;
      case "Bash":
        return context.sandbox !== "unavailable" && open.commands;
      default:
        return open.edit;
    }
  });
};

/**
 * Whether the turn offers commands that cannot write its folders: Bash is offered and Edit files is
 * Never, so the sandbox closes the folders, `.git` included, to every write (#1344).
 */
export const readOnlyCommands = (context: Pick<PolicyContext, "preset" | "hob" | "restrictions" | "sandbox">) =>
  offeredTools(context).includes("Bash") &&
  openTools((operation) => operationDecision(context, operation)).commandsReadOnly;

const text = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** A command line's separators, with a newline read as `;`. */
type Separator = ";" | "&&" | "||" | "|" | "&" | "(" | ")";

/** One piece of a command line: a simple command's words, or the separator between commands. */
type CommandToken = { readonly words: ReadonlyArray<string> } | { readonly separator: Separator };

/** The quoted text from `start` up to the closing `quote`, and where reading carries on. */
const readQuoted = (command: string, start: number, quote: "'" | '"'): { text: string; next: number } => {
  let text = "";
  let i = start;
  while (i < command.length && command[i] !== quote) {
    if (command[i] === "\\" && quote === '"' && i + 1 < command.length) {
      text += command[i + 1];
      i += 2;
    } else {
      text += command[i];
      i++;
    }
  }
  return { text, next: i + 1 };
};

/** The separator at `i`, or null. The `&` of a redirection such as `2>&1` or `&>file` is not one. */
const separatorAt = (command: string, i: number, word: string): { separator: Separator; length: number } | null => {
  const c = command[i];
  const next = command[i + 1];
  if (c === "\n" || c === ";") return { separator: ";", length: 1 };
  if (c === "(" || c === ")") return { separator: c, length: 1 };
  if (c === "|")
    return next === "|" ? { separator: "||", length: 2 } : { separator: "|", length: next === "&" ? 2 : 1 };
  if (c !== "&" || /[<>]$/.test(word) || next === ">") return null;
  return next === "&" ? { separator: "&&", length: 2 } : { separator: "&", length: 1 };
};

/** A redirection operator at the start of a word: `>`, `2>>`, `&>`, `2>&1`, `<in`, `<<<`. */
const REDIRECTION = /^(\d*|&)(>>|>\||>&|>|<<<|<<|<&|<>|<)/;

/**
 * The words of one simple command as they are read, with redirections left out. `plain` is the part
 * of the word before its first quote or escape: only an operator there is a redirection, so
 * `rm '>' file` still names both files while `2>"log"` is a redirection with a quoted target. A bare
 * operator (`> out`) also takes the next word, its target.
 */
const commandWords = () => {
  const words: Array<string> = [];
  let target = false;
  return {
    words,
    add: (word: string, plain: string) => {
      const operator = REDIRECTION.exec(plain)?.[0];
      if (target) target = false;
      else if (operator === undefined) words.push(word);
      else target = operator === word && plain === word;
    },
  };
};

/**
 * One shell command line as simple commands and the separators between them. Quotes are honored and
 * redirections dropped; anything subtler is not.
 */
const commandLine = (command: string): ReadonlyArray<CommandToken> => {
  const tokens: Array<CommandToken> = [];
  let current = commandWords();
  let word = "";
  let started = false;
  let plain = "";
  let quoted = false;
  const endWord = () => {
    if (started) current.add(word, plain);
    word = "";
    plain = "";
    started = false;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length > 0) tokens.push({ words: current.words });
    current = commandWords();
  };
  const take = (text: string) => {
    word += text;
    started = true;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    const separator = separatorAt(command, i, word);
    if (c === "'" || c === '"') {
      const read = readQuoted(command, i + 1, c);
      take(read.text);
      quoted = true;
      i = read.next;
    } else if (c === "\\" && i + 1 < command.length) {
      take(command[i + 1] as string);
      quoted = true;
      i += 2;
    } else if (separator !== null) {
      endCommand();
      tokens.push({ separator: separator.separator });
      i += separator.length;
    } else {
      if (c === " " || c === "\t") endWord();
      else {
        if (!quoted) plain += c;
        take(c);
      }
      i++;
    }
  }
  endCommand();
  return tokens;
};

/** One shell command line split into simple commands, each as its words. Quotes are honored; anything subtler is not. */
export const simpleCommands = (command: string): ReadonlyArray<ReadonlyArray<string>> =>
  commandLine(command).flatMap((token) => ("words" in token ? [token.words] : []));

/** An option word: its name, its value when it takes one, and how many words it uses. */
const readOption = (
  args: ReadonlyArray<string>,
  i: number,
  takesValue: ReadonlySet<string>,
): { name: string; value?: string | undefined; used: number } => {
  const arg = args[i] as string;
  const equals = arg.indexOf("=");
  if (arg.startsWith("--") && equals > 0) return { name: arg.slice(0, equals), value: arg.slice(equals + 1), used: 1 };
  const name = arg.startsWith("--") ? arg : arg.slice(0, 2);
  if (!takesValue.has(name)) return { name: arg, used: 1 };
  return arg.length > name.length
    ? { name, value: arg.slice(name.length), used: 1 }
    : { name, value: args[i + 1], used: 2 };
};

/** Words whose meaning only running the shell settles: expansions, substitutions, globs, `~user`. */
const isSettled = (word: string) => !/[$`*?[{]/.test(word) && !/^~[^/]/.test(word);

/**
 * The folder `target` names from `base`. A program that changes folder (`git -C`) joins without
 * normalizing, so the engine follows links the way the kernel does; the shell's own `cd` is
 * `logical` and takes `..` off the spelling. A folder Hobbots cannot work out is written as the words
 * that named it, which are never an absolute path, so the engine cannot resolve it and stays closed.
 */
const moveTo = (
  base: string,
  target: string | undefined,
  home: string | null,
  spelling: string,
  logical = false,
): string => {
  if (!isAbsolute(base)) return base;
  if (target === undefined || !isSettled(target)) return spelling;
  const expanded = expandHome(target, home);
  if (logical) return resolve(base, expanded);
  return isAbsolute(expanded) ? expanded : `${base}${sep}${expanded}`;
};

/**
 * A path a command names, with `~` spelled out. With no home the word is kept as written: a `~`
 * the command reader read was quoted, so the shell passes it on as a literal `~` (ADR 015).
 */
const expandHome = (word: string, home: string | null) =>
  home === null ? word : word === "~" ? home : word.startsWith("~/") ? `${home}${word.slice(1)}` : word;

/**
 * Programs that run the words after their options as the command: the options that take a value,
 * those that move to another folder or split a string into words, and the operands before the
 * command (`timeout 30`).
 */
interface Wrapper {
  readonly takesValue: ReadonlySet<string>;
  readonly chdir?: ReadonlySet<string>;
  readonly split?: ReadonlySet<string>;
  readonly operands?: number;
}

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  [
    "env",
    {
      takesValue: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"]),
      chdir: new Set(["-C", "--chdir"]),
      split: new Set(["-S", "--split-string"]),
    },
  ],
  ["command", { takesValue: new Set() }],
  ["builtin", { takesValue: new Set() }],
  ["exec", { takesValue: new Set(["-a"]) }],
  ["nohup", { takesValue: new Set() }],
  ["time", { takesValue: new Set(["-f", "--format", "-o", "--output"]) }],
  ["nice", { takesValue: new Set(["-n", "--adjustment"]) }],
  ["timeout", { takesValue: new Set(["-s", "--signal", "-k", "--kill-after"]), operands: 1 }],
  ["stdbuf", { takesValue: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]) }],
  ["caffeinate", { takesValue: new Set(["-t", "-w"]) }],
  [
    "xargs",
    {
      takesValue: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args"]),
    },
  ],
]);

interface Unwrapped {
  readonly words: ReadonlyArray<string>;
  /** The folder the command runs in. */
  readonly folder: string;
  /** The `VAR=value` words taken off before the program, its own or a wrapper's such as `env`. */
  readonly assignments?: ReadonlyArray<string>;
}

/** Skips one wrapper's options and operands, following the folder it moves to. */
const skipWrapper = (args: ReadonlyArray<string>, wrapper: Wrapper, folder: string, home: string): Unwrapped => {
  let i = 0;
  let where = folder;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    if (args[i] === "--") {
      i++;
      break;
    }
    const option = readOption(args, i, wrapper.takesValue);
    i += option.used;
    if (wrapper.chdir?.has(option.name)) where = moveTo(where, option.value, home, `env -C ${option.value ?? ""}`);
    if (wrapper.split?.has(option.name) && option.value !== undefined)
      return { words: [...simpleCommands(option.value).flat(), ...args.slice(i)], folder: where };
  }
  return { words: args.slice(i + (wrapper.operands ?? 0)), folder: where };
};

/** A `VAR=value` or `VAR+=value` word's name and value, or null for any other word. */
const assignmentOf = (word: string): { name: string; value: string } | null => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s.exec(word);
  return match === null ? null : { name: match[1] ?? "", value: match[2] ?? "" };
};

/** Drops leading `VAR=value` assignments and wrappers, in any order, so the real program is classified. */
const unwrap = (words: ReadonlyArray<string>, folder: string, home: string): Unwrapped => {
  const assignments: Array<string> = [];
  let current: Unwrapped = { words, folder, assignments };
  for (;;) {
    const [first, ...rest] = current.words;
    if (first === undefined) return current;
    if (assignmentOf(first) !== null) {
      assignments.push(first);
      current = { words: rest, folder: current.folder, assignments };
      continue;
    }
    const wrapper = WRAPPERS.get(basename(first));
    if (wrapper === undefined) return current;
    current = { ...skipWrapper(rest, wrapper, current.folder, home), assignments };
  }
};

// Git options that take a value before the subcommand.
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/** Push options that change nothing about which refs go where. */
const PLAIN_PUSH_OPTIONS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--progress"]);

/** Push options after which the refs pushed cannot be read from the words. */
const UNNAMED_REFS = new Set([
  "--all",
  "--branches",
  "--mirror",
  "--tags",
  "--follow-tags",
  "--delete",
  "-d",
  "--prune",
]);

const isForce = (a: string) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror";

/** One refspec's branch, and whether it forces or deletes. */
const refspecBranch = (refspec: string) => {
  const forced = refspec.startsWith("+");
  const [source, destination] = refspec.replace(/^\+/, "").split(":");
  const branch = (destination ?? source ?? "").replace(/^refs\/heads\//, "");
  // `:branch` deletes the branch on the remote.
  return { branch, forced: forced || (source === "" && branch !== "") };
};

/**
 * A `git push` as one Push request per refspec, so every branch it updates is decided. Unknown
 * remotes and branches are assumed the riskiest. `exact` is false when the words do not say
 * everything the push does, so no grant answers it (ADR 015).
 */
const pushRequests = (args: ReadonlyArray<string>, cwd: string, literal: boolean): ReadonlyArray<CommandRequest> => {
  const options = args.filter((a) => a.startsWith("-"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const force = options.some(isForce);
  const remote = positional[0] ?? "origin";
  const exact = literal && options.every((a) => PLAIN_PUSH_OPTIONS.has(a));
  const push = (branch: string, forced: boolean, toDefaultBranch: boolean, exactPush: boolean): CommandRequest => ({
    _tag: "Push",
    remote,
    branch,
    force: force || forced,
    toDefaultBranch,
    cwd,
    exact: exactPush,
  });
  if (options.some((a) => UNNAMED_REFS.has(a))) return [push("(several branches)", false, true, false)];
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return [push("(current branch)", false, true, false)];
  return refspecs.map((refspec) => {
    const { branch, forced } = refspecBranch(refspec);
    // A pattern (`refs/heads/*`), `:` or `+:` (every matching branch) and `HEAD` or `@` (the current
    // branch) do not name the branches they update, so they may reach the default branch.
    if (branch === "" || branch.includes("*") || branch === "HEAD" || branch === "@") {
      return push(`(${refspec})`, forced, true, false);
    }
    return push(branch, forced, DEFAULT_BRANCHES.has(branch), exact);
  });
};

/** The folder a Git directory belongs to: the one holding it when it is a `.git`, else itself, a bare repository. */
const repositoryOf = (gitDir: string) => (isAbsolute(gitDir) && basename(gitDir) === ".git" ? dirname(gitDir) : gitDir);

/**
 * The folders `git` works in after its `-C`, `--git-dir` and `--work-tree` options, the repository
 * first, and the index of its subcommand. Git takes every `-C` before it resolves the other two, and
 * finds the repository from the folder it runs in unless `--git-dir` names one; a working tree is
 * that folder unless `--work-tree` names another. Each folder Git may change is named, so the
 * folder it runs in always is. `settings` are the keys its `-c` and `--config-env` options set.
 */
const gitFolders = (
  args: ReadonlyArray<string>,
  folder: string,
  home: string | null,
): { folders: ReadonlyArray<string>; sub: number; settings: ReadonlyArray<string> } => {
  let i = 0;
  let where = folder;
  const named: Array<{ name: "--git-dir" | "--work-tree"; value: string | undefined }> = [];
  const settings: Array<string> = [];
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const option = readOption(args, i, GIT_VALUE_OPTIONS);
    if (option.name === "-c" || option.name === "--config-env") settings.push((option.value ?? "").split("=")[0] ?? "");
    else if (option.name === "-C") where = moveTo(where, option.value, home, `git -C ${option.value ?? ""}`);
    else if (option.name === "--git-dir" || option.name === "--work-tree")
      named.push({ name: option.name, value: option.value });
    i += option.used;
  }
  const last = (name: "--git-dir" | "--work-tree") => {
    const option = named.findLast((o) => o.name === name);
    return option === undefined ? undefined : moveTo(where, option.value, home, `git ${name} ${option.value ?? ""}`);
  };
  const gitDir = last("--git-dir");
  // Git still writes some files, such as `archive -o` or `format-patch`, in the folder it runs in.
  const folders = [gitDir === undefined ? where : repositoryOf(gitDir), last("--work-tree") ?? where, where];
  return { folders: [...new Set(folders)], sub: i, settings };
};

const MAKE_CHDIR = new Set(["-C", "--directory"]);

/** The folder `make` runs in after its `-C` options. */
const makeFolder = (args: ReadonlyArray<string>, folder: string, home: string | null): string => {
  let where = folder;
  for (let i = 0; i < args.length; ) {
    const option = (args[i] as string).startsWith("-") ? readOption(args, i, MAKE_CHDIR) : { name: "", used: 1 };
    if (MAKE_CHDIR.has(option.name)) where = moveTo(where, option.value, home, `make -C ${option.value ?? ""}`);
    i += option.used;
  }
  return where;
};

const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink"]);

/**
 * The requests one simple command makes in `folder`: running it, plus any Git, push or delete it is
 * recognized as. `literal` is the simple command's literal words as the hub's command reader read
 * them, before any wrapper is taken off, or null: only then can a grant match it exactly (ADR 015).
 */
const programRequests = (
  words: ReadonlyArray<string>,
  folder: string,
  home: string,
  literal: ReadonlyArray<string> | null,
): ReadonlyArray<CommandRequest> => {
  const [name, ...args] = words;
  if (name === undefined) return [];
  const program = basename(name);
  // The reader reads no unquoted `~`, so in literal words every `~` is the shell's literal `~`.
  const tilde = literal === null ? home : null;
  if (program === "git") {
    const git = gitFolders(args, folder, tilde);
    // Options before the subcommand, such as `-C` or `-c`, change where or how a push runs.
    return args[git.sub] === "push"
      ? pushRequests(args.slice(git.sub + 1), git.folders[0] as string, literal !== null && git.sub === 0)
      : git.folders.map((cwd) => ({ _tag: "Command", operation: "local-git", cwd, words: literal }));
  }
  const run: CommandRequest = {
    _tag: "Command",
    operation: "run-commands",
    cwd: program === "make" ? makeFolder(args, folder, tilde) : folder,
    words: literal,
  };
  if (!DELETE_PROGRAMS.has(program)) return [run];
  const paths = args.filter((a) => !a.startsWith("-")).map((a) => expandHome(a, tilde));
  // Paths from a line the reader could not read may expand into other files, so no rule covers them.
  return [
    {
      _tag: "Files",
      operation: "delete-files",
      paths: paths.length > 0 ? paths : ["."],
      cwd: folder,
      exact: literal !== null,
    },
    run,
  ];
};

const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);

/**
 * The folder a `cd`, `pushd` or `popd` moves the shell to from `folder`. Like the shell's default,
 * `..` is taken off the folder's spelling, so `cd link && cd ..` comes back. A folder the words
 * cannot settle (`cd "$DIR"`, `cd -`, `popd`, `cd -P`, which follows links Hobbots does not read) is
 * not worked out.
 */
const changedFolder = (words: ReadonlyArray<string>, folder: string, home: string): string => {
  const [name, ...args] = words;
  const [target] = args.filter((a) => a === "-" || !a.startsWith("-"));
  const unsettled =
    name === "popd" ||
    target === "-" ||
    args.some((a) => /^-[A-Za-z@]*P/.test(a)) ||
    (name === "pushd" && (target === undefined || /^[+-]\d+$/.test(target)));
  return moveTo(folder, unsettled ? undefined : (target ?? "~"), home, words.join(" "), true);
};

/** The folders the shell may be in after the last command, if it succeeded and if it failed. */
interface Flow {
  readonly ok: ReadonlySet<string>;
  readonly fail: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();
const union = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> => new Set([...a, ...b]);

/** Where the next command runs, given the separator before it. */
const entering = (flow: Flow, separator: Separator | undefined) =>
  separator === "&&" ? flow.ok : separator === "||" ? flow.fail : union(flow.ok, flow.fail);

/** The flow after a command joined to what came before by `separator`; a skipped command passes the status on. */
const joined = (separator: Separator | undefined, before: Flow, after: Flow): Flow => {
  if (separator === "&&") return { ok: after.ok, fail: union(after.fail, before.fail) };
  if (separator === "||") return { ok: union(before.ok, after.ok), fail: after.fail };
  return after;
};

/** Written in place of a folder when a command could run in more than one, so the engine stays closed. */
const SEVERAL_FOLDERS = "(one of several folders, depending on which earlier cd ran)";

/** The one folder a command runs in, or a marker the engine cannot resolve. */
const single = (folders: ReadonlySet<string>): string =>
  folders.size === 1 ? ([...folders][0] as string) : SEVERAL_FOLDERS;

/**
 * Follows the folders a command line moves through. Each command runs in every folder the shell may
 * be in by then: `false && cd sub; rm x` may remove `x` in either folder, so that is not worked out.
 * A `cd` is taken to succeed unless `||` follows it, and moves nothing from a subshell, a pipeline
 * or a list run in the background (`cd sub && make & rm x` removes `x` where the line started).
 */
const folderFlow = (cwd: string, home: string) => {
  let flow: Flow = { ok: new Set([cwd]), fail: NONE };
  let separator: Separator | undefined;
  // The pipeline being run: what came before it and how it is joined. Its status is its last command's.
  let pipeline = { separator, before: flow, folders: flow.ok };
  // Where the current `&&`/`||` list started, which is where the shell stays when it runs in the background.
  let list = flow.ok;
  const subshells: Array<{ pipeline: typeof pipeline; list: ReadonlySet<string> }> = [];
  const start = () => {
    if (separator !== "|") pipeline = { separator, before: flow, folders: entering(flow, separator) };
    if (separator !== "|" && separator !== "&&" && separator !== "||") list = pipeline.folders;
    return pipeline.folders;
  };
  const finish = (outcome: Flow) => {
    flow = joined(pipeline.separator, pipeline.before, outcome);
    separator = undefined;
  };
  return {
    separator: (next: Separator) => {
      if (next === "(") {
        const folders = start();
        subshells.push({ pipeline, list });
        flow = { ok: folders, fail: NONE };
        separator = undefined;
      } else if (next === ")") {
        const outer = subshells.pop();
        if (outer !== undefined) ({ pipeline, list } = outer);
        finish({ ok: pipeline.folders, fail: pipeline.folders });
      } else if (next === "&") {
        flow = { ok: list, fail: NONE };
        separator = next;
      } else separator = next;
    },
    /** The folder `words` runs in, moving the flow past it. `after` is the separator that follows it. */
    command: (words: ReadonlyArray<string>, after: Separator | undefined): string => {
      const inPipeline = separator === "|" || after === "|";
      const folders = start();
      const moves = DIRECTORY_COMMANDS.has(words[0] ?? "") && !inPipeline;
      finish(
        moves
          ? {
              ok: new Set([...folders].map((f) => changedFolder(words, f, home))),
              fail: after === "||" ? folders : NONE,
            }
          : { ok: folders, fail: folders },
      );
      return single(folders);
    },
  };
};

const separatorOf = (token: CommandToken | undefined): Separator | undefined =>
  token !== undefined && "separator" in token ? token.separator : undefined;

/**
 * The requests one shell command line makes, each in the folder the line has moved to by then:
 * `cd` and `pushd` move later commands, and `git -C`, `make -C` and `env -C` move their own.
 * Relative paths start from `cwd`, the folder the runtime reports for the call, and `~` from `home`.
 */
export const commandRequests = (
  command: string,
  cwd: string,
  home: string = homedir(),
): ReadonlyArray<CommandRequest> => {
  const requests: Array<CommandRequest> = [];
  const add = (request: CommandRequest) => {
    const key = JSON.stringify(request);
    if (!requests.some((r) => JSON.stringify(r) === key)) requests.push(request);
  };
  const tokens = commandLine(command);
  const folders = folderFlow(cwd, home);
  // The reader splits a line it can read where this does, so its commands line up one to one.
  const read = readCommandLine(command);
  const simple = tokens.filter((token) => "words" in token).length;
  const literal = read !== null && read.length === simple ? read : null;
  const plain = !/[<>]/.test(command);
  let position = 0;
  tokens.forEach((token, index) => {
    if ("separator" in token) {
      folders.separator(token.separator);
      return;
    }
    const literalWords = literal?.[position++] ?? null;
    // A wrapper such as `command cd` still moves the shell, so the flow sees the unwrapped words.
    const preview = unwrap(token.words, cwd, home).words;
    const folder = folders.command(preview, separatorOf(tokens[index + 1]));
    const unwrapped = unwrap(token.words, folder, home);
    // A settled `cd` runs nothing: it moves the shell, and each command after it is decided in the
    // folder it moved to, so it names no folder of its own (#670). A line with a redirection or a
    // process substitution may still act where it started, so there it is decided as before.
    if (plain && DIRECTORY_COMMANDS.has(unwrapped.words[0] ?? "") && unwrapped.words.every(isSettled)) return;
    for (const request of programRequests(unwrapped.words, unwrapped.folder, home, literalWords)) add(request);
  });
  if (requests.length === 0) add({ _tag: "Command", operation: "run-commands", cwd });
  return requests;
};

/** Whether any simple command in a Bash call's command line, its wrappers taken off, passes `test`. */
const someCommand = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string,
  test: (command: Unwrapped, raw: ReadonlyArray<string>) => boolean,
): boolean => {
  const command = tool === "Bash" ? text(input, "command") : undefined;
  return (
    command !== undefined &&
    commandLine(command).some((token) => "words" in token && test(unwrap(token.words, cwd, home), token.words))
  );
};

/**
 * Whether a tool call runs `git init`, behind any wrapper or Git option, anywhere in its command
 * line. In the sandbox it cannot write the new repository's config, so the hub makes it (ADR 014).
 */
export const initsRepository = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): boolean =>
  someCommand(
    tool,
    input,
    cwd,
    home,
    ({ words: [name, ...args] }) =>
      name !== undefined && basename(name) === "git" && args[gitFolders(args, cwd, home).sub] === "init",
  );

/**
 * The folders a tool call's command line runs a `git` subcommand from that `matches` picks (with
 * `every`, also its `--git-dir` repository and `--work-tree`), as the line spells them, after any `cd`, `git -C` or wrapper such as `env -C`, and inside `eval` or
 * `sh -c` (#742). Which repository each is in is the hub's to find. Only what the line says is read:
 * an alias or a script that runs Git is not seen.
 */
const gitFoldersWhere = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string,
  matches: (sub: string, rest: ReadonlyArray<string>, settings: ReadonlyArray<string>) => boolean,
  every = false,
): ReadonlyArray<string> => {
  const found = new Set<string>();
  const visit = (line: string, at: string) => {
    const tokens = commandLine(line);
    const folders = folderFlow(at, home);
    tokens.forEach((token, index) => {
      if ("separator" in token) {
        folders.separator(token.separator);
        return;
      }
      // A wrapper such as `env -C` moves the command it runs, so the folder is the unwrapped one.
      const shell = folders.command(unwrap(token.words, at, home).words, separatorOf(tokens[index + 1]));
      const { words, folder } = unwrap(token.words, shell, home);
      const [name, ...args] = words;
      const program = basename(name ?? "");
      if (program === "git") {
        const git = gitFolders(args, folder, home);
        const sub = args[git.sub];
        if (sub !== undefined && matches(sub, args.slice(git.sub + 1), git.settings))
          for (const reached of every ? git.folders : git.folders.slice(0, 1)) found.add(reached);
      } else {
        const nested = nestedLine(program, args);
        if (nested !== undefined) visit(nested, folder);
      }
    });
  };
  const command = tool === "Bash" ? text(input, "command") : undefined;
  if (command !== undefined) visit(command, cwd);
  return [...found];
};

/** The folders a tool call's command line runs `git commit` from (#742); see `gitFoldersWhere`. */
export const commitFolders = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): ReadonlyArray<string> => gitFoldersWhere(tool, input, cwd, home, (sub) => sub === "commit");

/**
 * Git subcommands known to leave the working tree's files alone. Every other subcommand, such as
 * `reset` in any mode, `checkout`, `checkout-index -f`, `clean` or one Git adds later, is read as one
 * that may rewrite them, so a subcommand missing here is refused rather than let through.
 */
const TREE_KEEPS = new Set([
  "add",
  "blame",
  "cat-file",
  "commit",
  "config",
  "describe",
  "diff",
  "fetch",
  "for-each-ref",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "push",
  "reflog",
  "remote",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "tag",
  "version",
]);
/** `git branch` options that move, copy or delete a branch; without them it only lists or makes one. */
const BRANCH_MOVES = new Set(["-f", "--force", "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy"]);
/** `git stash` forms that only read. */
const STASH_READS = new Set(["list", "show", "create"]);

const rewritesTree = (sub: string, rest: ReadonlyArray<string>, settings: ReadonlyArray<string>) => {
  // A setting given on the line, such as `-c remote.origin.fetch=...:refs/heads/taken`, can make
  // any subcommand write where its words don't say, so the line is read as a rewrite.
  if (settings.length > 0) return true;
  if (sub === "branch") return rest.some((word) => BRANCH_MOVES.has(word));
  // A fetch whose refspec names where it lands, such as `HEAD:refs/heads/taken`, may move a local branch.
  if (sub === "fetch")
    return rest.some((word) => word === "--update-head-ok" || (!word.startsWith("-") && word.includes(":")));
  if (sub === "stash") return rest[0] === undefined || !STASH_READS.has(rest[0]);
  return !TREE_KEEPS.has(sub);
};

/**
 * The folders a tool call's command line runs a Git subcommand from that rewrites the working tree,
 * or may move a branch, such as `git reset --hard`, `git switch`, `git clean` or `git branch -f`, or
 * any subcommand not known to leave both alone (#1449), with any `--git-dir` or `--work-tree` it
 * names. Which files or branches each reaches is not read from the line, so the hub treats the
 * whole repository as written.
 */
export const treeRewriteFolders = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): ReadonlyArray<string> => gitFoldersWhere(tool, input, cwd, home, rewritesTree, true);

/** The arguments of the first `gh` a command line runs, behind any wrapper, `eval` or `sh -c`, or null. */
/** Shell words that start or join a compound command, before the command that runs. */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "(", "time"]);

/** A simple command's words with any leading shell keywords, such as `if` or `do`, taken off. */
const afterKeywords = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  let i = 0;
  while (i < words.length && SHELL_KEYWORDS.has(words[i] as string)) i++;
  return words.slice(i);
};

/** A shell quote a scan is inside: none, single quotes or double quotes. */
type Quoting = "" | "'" | '"';

/**
 * The quoting after `char`, read in `quoting`: an apostrophe opens or closes single quotes only
 * outside double quotes, and a double quote opens or closes double quotes only outside single ones.
 */
const nextQuoting = (quoting: Quoting, char: string | undefined): Quoting => {
  if (quoting === "'") return char === "'" ? "" : "'";
  if (char === '"') return quoting === '"' ? "" : '"';
  return quoting === "" && char === "'" ? "'" : quoting;
};

/**
 * Where the `$(` body that starts at `start` ends: its closing parenthesis, or the line's end.
 * Parentheses in quotes inside it do not count.
 */
const closingParen = (line: string, start: number): number => {
  let depth = 1;
  let quoting: Quoting = "";
  for (let i = start; i < line.length; i++) {
    const char = line[i];
    if (quoting !== "'" && char === "\\") i++;
    else if (char === "'" || char === '"' || quoting === "'") quoting = nextQuoting(quoting, char);
    else if (quoting === "" && char === "(") depth++;
    else if (quoting === "" && char === ")" && --depth === 0) return i;
  }
  return line.length;
};

/** Where the backtick body that starts at `start` ends: its closing backtick, or the line's end. */
const closingBacktick = (line: string, start: number): number => {
  for (let i = start; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "`") return i;
  }
  return line.length;
};

/** The substitution that starts at `i`, its body and where it ends, or null when none starts there. */
const substitutionAt = (line: string, i: number): { readonly body: string; readonly end: number } | null => {
  if (line[i] === "$" && line[i + 1] === "(") {
    const end = closingParen(line, i + 2);
    return { body: line.slice(i + 2, end), end };
  }
  if (line[i] !== "`") return null;
  const end = closingBacktick(line, i + 1);
  return { body: line.slice(i + 1, end), end };
};

/**
 * The command lines a line's `$(…)` and backtick substitutions run, also inside double quotes, which
 * the shell runs too, an apostrophe there included; only single quotes keep them literal. Read in one
 * pass, so in linear time.
 */
const substitutions = (line: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  let quoting: Quoting = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const substitution = quoting === "'" ? null : substitutionAt(line, i);
    if (substitution !== null) {
      found.push(substitution.body);
      i = substitution.end;
    } else if (quoting !== "'" && char === "\\") i++;
    else quoting = nextQuoting(quoting, char);
  }
  return found;
};

/** The arguments of the first `gh` one simple command runs, or the line it runs in turn, or null. */
const ghInCommand = (
  words: ReadonlyArray<string>,
  cwd: string,
  home: string,
): ReadonlyArray<string> | null | { readonly line: string } => {
  const [name, ...args] = unwrap(afterKeywords(words), cwd, home).words;
  const program = basename(name ?? "");
  if (program === "gh") return args;
  const nested = nestedLine(program, args);
  return nested === undefined ? null : { line: nested };
};

/**
 * The arguments of the first `gh` a command line runs, behind any wrapper or shell keyword such as
 * `if`, inside `eval`, `sh -c` or a command substitution, or null.
 */
const ghIn = (line: string, cwd: string, home: string): ReadonlyArray<string> | null => {
  for (const token of commandLine(line)) {
    if (!("words" in token)) continue;
    const found = ghInCommand(token.words, cwd, home);
    const args = found !== null && "line" in found ? ghIn(found.line, cwd, home) : found;
    if (args !== null) return args;
  }
  for (const inner of substitutions(line)) {
    const args = ghIn(inner, cwd, home);
    if (args !== null) return args;
  }
  return null;
};

/**
 * The arguments of the first `gh` a tool call's command line runs, after any wrapper such as `env`
 * or shell keyword such as `if`, and inside `eval`, `sh -c` or a `$(…)` or backtick substitution,
 * or null when it runs none (#1349). Only what the line says is read:
 * an alias or a script that runs `gh` is not seen, and fails to sign in on its own.
 */
export const ghArguments = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): ReadonlyArray<string> | null => {
  const command = tool === "Bash" ? text(input, "command") : undefined;
  return command === undefined ? null : ghIn(command, cwd, home);
};

/** Variables that name a commit's author or committer, or pass Git settings or a config file. */
const IDENTITY_VARIABLES: ReadonlySet<string> = new Set([
  ...GIT_IDENTITY_VARIABLES,
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG",
]);

/**
 * Whether a variable's name is one that sets a commit's identity, or one the hub sets it with
 * (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, ADR 022).
 */
const isIdentityVariable = (name: string) =>
  IDENTITY_VARIABLES.has(name) || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name);

/** Git settings that name a commit's author or committer, or pull in a config file that may. */
const IDENTITY_SETTING = /^((user|author|committer)\.(name|email)|include\.path|includeif\..*\.path)$/i;

/**
 * Variables that name a commit's author or committer over the hub's settings, or pass Git settings
 * or config files that may. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` may only switch a file off.
 */
const overridingVariable = (word: string) => {
  const assignment = assignmentOf(word);
  if (assignment === null) return false;
  const { name, value } = assignment;
  return CONFIG_FILES.test(name) ? value !== "/dev/null" : isIdentityVariable(name);
};

/** Builtins that set variables for every command after them in the shell. */
const SETS_VARIABLES = new Set(["export", "declare", "typeset", "readonly", "local"]);

/** Shells whose `-c` runs a command line of its own. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The command line `eval` or a shell's `-c` runs, which is read like the outer one, or undefined. */
const nestedLine = (program: string, args: ReadonlyArray<string>): string | undefined => {
  if (program === "eval") return args.join(" ");
  if (!SHELLS.has(program)) return undefined;
  const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
  return flag === -1 ? undefined : (args[flag + 1] ?? "");
};

/** `git commit`'s long options that take a value, so the word after one is never read as an option. */
const COMMIT_VALUE_OPTIONS = [
  "message",
  "file",
  "reuse-message",
  "reedit-message",
  "author",
  "date",
  "template",
  "cleanup",
  "fixup",
  "squash",
  "trailer",
  "pathspec-from-file",
];

/** `git commit`'s short options that take a value: the rest of their word, or the next word. */
const COMMIT_VALUE_LETTERS = "mFCct";

/** Whether `long`, a long option's name without its dashes, is a prefix Git accepts for `full`. */
const prefixOf = (long: string, full: string, shortest: number) => long.length >= shortest && full.startsWith(long);

/**
 * Whether `git commit`'s arguments take the author from elsewhere: `--author`, or `-C`, `-c`,
 * `--reuse-message` or `--reedit-message`, which copy another commit's, without `--reset-author`.
 * Each option's value is skipped, so a message such as `-m --reset-author` is never read as one.
 */
const commitTakesAuthor = (args: ReadonlyArray<string>): boolean => {
  let takes = false;
  let resets = false;
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const option = commitOption(args[i] as string);
    takes ||= option.takes;
    resets ||= option.resets;
    if (option.valueNext) i++;
  }
  return takes && !resets;
};

/** One `git commit` argument: whether it takes or resets the author, and whether the next word is its value. */
const commitOption = (arg: string): { takes: boolean; resets: boolean; valueNext: boolean } => {
  if (arg.startsWith("--")) {
    const equals = arg.indexOf("=");
    const long = arg.slice(2, equals === -1 ? undefined : equals);
    return {
      takes: prefixOf(long, "author", 2) || prefixOf(long, "reuse-message", 3) || prefixOf(long, "reedit-message", 3),
      resets: prefixOf(long, "reset-author", 3),
      valueNext: equals === -1 && long !== "" && COMMIT_VALUE_OPTIONS.some((full) => full.startsWith(long)),
    };
  }
  if (!arg.startsWith("-")) return { takes: false, resets: false, valueNext: false };
  // A cluster such as `-aC abc` ends at its first letter that takes a value.
  const letters = arg.slice(1);
  const valued = [...letters].findIndex((letter) => COMMIT_VALUE_LETTERS.includes(letter));
  const options = valued === -1 ? letters : letters.slice(0, valued + 1);
  return {
    takes: options.includes("C") || options.includes("c"),
    resets: false,
    valueNext: valued === letters.length - 1,
  };
};

/** `git config` words that write a setting, besides a value after its key. */
const CONFIG_WRITES = /^(set|unset|--add|--replace-all|--unset|--unset-all)$/;

/** `env` options that drop the environment, or part of it, that the hub sets. */
const DROPS_ENVIRONMENT = /^(-|--ignore-environment|--unset|-[A-Za-z]*[iu][A-Za-z]*)$/;

const ENV = WRAPPERS.get("env") as Wrapper;

/**
 * Whether an `env` among a simple command's raw words drops what the hub sets. Its options are read
 * with their values, as `unwrap` reads them, so `env -C . -i` is read to its end, and the words a
 * `-S` splits are read too.
 */
const dropsEnvironment = (raw: ReadonlyArray<string>): boolean =>
  raw.some((word, i) => {
    if (basename(word) !== "env") return false;
    for (let j = i + 1; j < raw.length && (raw[j] as string).startsWith("-") && raw[j] !== "--"; ) {
      const option = readOption(raw, j, ENV.takesValue);
      if (DROPS_ENVIRONMENT.test(option.name)) return true;
      if (ENV.split?.has(option.name) && dropsEnvironment(["env", ...simpleCommands(option.value ?? "").flat()]))
        return true;
      j += option.used;
    }
    return false;
  });

/** Whether a Git command sets the commit identity: with `-c`, `git config` or `git commit`'s options. */
const gitSetsIdentity = (args: ReadonlyArray<string>, folder: string): boolean => {
  const { sub, settings } = gitFolders(args, folder, null);
  // A key the shell only settles when it runs may be any.
  if (settings.some((key) => !isSettled(key) || IDENTITY_SETTING.test(key))) return true;
  const rest = args.slice(sub + 1);
  if (args[sub] === "config") {
    const key = rest.findIndex((word) => IDENTITY_SETTING.test(word));
    return key !== -1 && (rest[key + 1] !== undefined || rest.some((word) => CONFIG_WRITES.test(word)));
  }
  return args[sub] === "commit" && commitTakesAuthor(rest);
};

/** Whether one simple command, its wrappers taken off, sets the commit identity itself. */
const setsIdentity =
  (home: string) =>
  ({ words, folder, assignments = [] }: Unwrapped, raw: ReadonlyArray<string>): boolean => {
    const [name, ...args] = words;
    if (assignments.some(overridingVariable)) return true;
    if (name === undefined) return false;
    const program = basename(name);
    // A push makes no commit, and the policy decides it as a Push whatever its environment.
    const pushes = program === "git" && args[gitFolders(args, folder, null).sub] === "push";
    if (!pushes && dropsEnvironment(raw)) return true;
    if (SETS_VARIABLES.has(program)) return args.some(overridingVariable);
    if (program === "unset") return args.some(isIdentityVariable);
    // A command line run by another shell, or by `eval`, is read the same way.
    const nested = (line: string) => overridesCommitIdentity("Bash", { command: line }, folder, home);
    const line = nestedLine(program, args);
    if (line !== undefined) return nested(line);
    if (SHELLS.has(program)) return false;
    return program === "git" && gitSetsIdentity(args, folder);
  };

/**
 * Whether a tool call's command line sets who its commits are made as (#700): Git's `-c user.*`,
 * `--config-env`, `git config user.*`, `git commit --author` or `-C`, the `GIT_AUTHOR_*`,
 * `GIT_COMMITTER_*` and Git config variables, or dropping those the hub sets, behind any wrapper,
 * `export`, `unset`, `eval` or `sh -c`. The hub sets every hob's identity, so none is let through.
 */
export const overridesCommitIdentity = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): boolean => someCommand(tool, input, cwd, home, setsIdentity(home));

/** Programs whose path arguments are where they write. */
const PATH_WRITERS = new Set(["touch", "mkdir", "cp", "mv", "tee", "install", "ln"]);

/**
 * The absolute paths a command line writes by redirection, or names to a program that writes its
 * path arguments, such as `cp` or `tee`, among those `matches` picks. Only what the line says is
 * read: a path a variable holds is not known here.
 */
export const commandWritesTo = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  matches: (path: string) => boolean,
  home: string = homedir(),
): ReadonlyArray<string> => {
  const command = tool === "Bash" ? text(input, "command") : undefined;
  if (command === undefined) return [];
  const found = new Set<string>();
  const add = (word: string) => {
    if (isAbsolute(word) && matches(word)) found.add(word);
  };
  const raw = rawTokens(command);
  raw.forEach((token, index) => {
    if (!("word" in token)) return;
    const operator = REDIRECTION.exec(token.word)?.[0];
    if (operator === undefined || !operator.includes(">") || operator.endsWith("&")) return;
    const rest = token.word.slice(operator.length);
    const next = raw[index + 1];
    const target = rest !== "" ? rest : next !== undefined && "word" in next ? next.word : "";
    add(unquoted(target));
  });
  for (const token of commandLine(command)) {
    if (!("words" in token)) continue;
    const [name, ...args] = unwrap(token.words, cwd, home).words;
    if (name !== undefined && PATH_WRITERS.has(basename(name))) {
      for (const arg of args) if (!arg.startsWith("-")) add(arg);
    }
  }
  return [...found];
};

/**
 * The policy requests a tool call makes, or null for a tool Hobbots does not know. Relative paths
 * resolve against `cwd`, the folder the runtime reports for the call.
 */
export const toolRequests = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): ReadonlyArray<ToolRequest> | null => {
  const files = (operation: "read-files" | "edit-files", path: string | undefined): ReadonlyArray<ToolRequest> => [
    { _tag: "Files", operation, paths: path === undefined ? [] : [path], cwd },
  ];
  switch (tool) {
    case "Read":
      return files("read-files", text(input, "file_path"));
    case "Glob":
    case "Grep":
      // Without a path both search the folder the runtime is in.
      return files("read-files", text(input, "path") ?? cwd);
    case "Write":
    case "Edit":
    case "MultiEdit":
      return files("edit-files", text(input, "file_path"));
    case "NotebookEdit":
      return files("edit-files", text(input, "notebook_path"));
    case "Bash": {
      const command = text(input, "command");
      return command === undefined
        ? [{ _tag: "Command", operation: "run-commands", cwd }]
        : commandRequests(command, cwd);
    }
    case "apply_patch":
      return patchRequests(input, cwd);
    case WEB_SEARCH_TOOL:
      return [{ _tag: "Search", operation: "search-web", query: text(input, "query") ?? "" }];
    default:
      return null;
  }
};

/** The changes of a Codex patch, as `policyGate` records them. */
const patchChanges = (input: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(input.changes) ? (input.changes as ReadonlyArray<Record<string, unknown>>) : [];

/**
 * The policy requests of a Codex patch (ADR 024): the files it deletes as a deletion, and the files
 * it adds, changes, moves and moves to as an edit, so a patch that deletes is decided as one
 * (STD-SEC-002). A patch that names no file is an edit of nothing, which the gate refuses first.
 */
const patchRequests = (input: Record<string, unknown>, cwd: string): ReadonlyArray<ToolRequest> => {
  const changes = patchChanges(input);
  const deleted = changes.filter((change) => change.kind === "delete");
  const edited = changes.filter((change) => change.kind !== "delete");
  const requests: Array<ToolRequest> = [];
  if (edited.length > 0 || deleted.length === 0) {
    requests.push({ _tag: "Files", operation: "edit-files", paths: patchPaths({ changes: edited }), cwd });
  }
  if (deleted.length > 0) {
    requests.push({ _tag: "Files", operation: "delete-files", paths: patchPaths({ changes: deleted }), cwd });
  }
  return requests;
};

/** Every path a Codex patch touches: each file it adds, changes or deletes, and where it moves one. */
export const patchPaths = (input: Record<string, unknown>): ReadonlyArray<string> => {
  const changes = patchChanges(input);
  return [
    ...new Set(
      changes
        .flatMap((change) => [text(change, "path"), text(change, "move_path")])
        .filter((path) => path !== undefined),
    ),
  ];
};

const shorten = (value: string, limit = 60) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);

/** How long a command label gets before it is cut. */
const COMMAND_LABEL_LIMIT = 100;

/** One piece of a command line as written, a word with its quotes or a separator, and whether a space came before it. */
type RawToken = ({ readonly word: string } | { readonly separator: string }) & { readonly spaced: boolean };

/** A command line as written, split into words and separators, with quotes kept. */
const rawTokens = (line: string): ReadonlyArray<RawToken> => {
  const tokens: Array<RawToken> = [];
  let word = "";
  let spaced = false;
  const endWord = () => {
    if (word !== "") tokens.push({ word, spaced });
    if (word !== "") spaced = false;
    word = "";
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    const separator = separatorAt(line, i, word);
    if (c === "'" || c === '"') {
      const next = readQuoted(line, i + 1, c).next;
      word += line.slice(i, next);
      i = next;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line.slice(i, i + 2);
      i += 2;
    } else if (separator !== null) {
      endWord();
      tokens.push({ separator: line.slice(i, i + separator.length), spaced });
      spaced = false;
      i += separator.length;
    } else {
      if (c === " " || c === "\t") {
        endWord();
        spaced = true;
      } else word += c;
      i++;
    }
  }
  endWord();
  return tokens;
};

/** A word as the shell reads it, quotes taken off. */
const unquoted = (word: string) => simpleCommands(word)[0]?.[0] ?? word;

/**
 * Variables that only set how output looks or which settings are left out, so a label can leave
 * them out. Any other may change what runs (`GIT_SSH_COMMAND`, `NODE_OPTIONS`, `PATH`), so it stays.
 */
const PLAIN_VARIABLES =
  /^(GIT_CONFIG_NOSYSTEM|GIT_TERMINAL_PROMPT|CI|FORCE_COLOR|NO_COLOR|TERM|COLUMNS|LANG|LC_[A-Z]+|TZ|NODE_ENV)$/;

/** Git's own config files, which a label can leave out only when they are switched off. */
const CONFIG_FILES = /^GIT_CONFIG_(GLOBAL|SYSTEM)$/;

/**
 * A leading `VAR=value` word that only sets the program's environment, so the label can leave it
 * out: `GIT_CONFIG_GLOBAL=/dev/null`, `NO_COLOR=1`. A value that runs code or expands is kept.
 */
const isPlainAssignment = (word: string) => {
  const assignment = assignmentOf(word);
  if (assignment === null) return false;
  const { name, value } = assignment;
  if (/[$`<>]/.test(value)) return false;
  return PLAIN_VARIABLES.test(name) || (CONFIG_FILES.test(name) && value === "/dev/null");
};

/**
 * A Git command's words without its `-C` options, whose folder the step lists under On:
 * `git -C ~/project log` reads `git log`. With `--git-dir` or `--work-tree` the command is decided
 * on more than one folder and On names only one, and a push shows its remote instead, so there
 * every folder option stays.
 */
const withoutGitFolder = <T extends { readonly word: string }>(words: ReadonlyArray<T>): ReadonlyArray<T> => {
  const args = words.map(({ word }) => unquoted(word));
  const kept = [words[0] as T];
  let i = 1;
  let several = false;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const option = readOption(args, i, GIT_VALUE_OPTIONS);
    if (option.name === "--git-dir" || option.name === "--work-tree") several = true;
    if (option.name !== "-C") kept.push(...words.slice(i, i + option.used));
    i += option.used;
  }
  // A push is shown on its remote and branch, so its repository stays in the label.
  return several || args[i] === "push" ? words : [...kept, ...words.slice(i)];
};

/** A path in a word, from its start or after `=`, `:` or a quote, up to its end or a quote. */
const LONG_PATH = /(^|[=:'"])(~?(?:\/[^/\s'"]+)+)(?=$|['"])/;

/** A path of four parts or more cut to its last two, `…/src/app.ts`, so the rest of the command stays in view. */
const shortPath = (word: string) =>
  word.replace(LONG_PATH, (match, before: string, path: string) => {
    const parts = path.split("/");
    return parts.length > 4 ? `${before}…/${parts.slice(-2).join("/")}` : match;
  });

/**
 * A command line as a step label: its first line, without leading assignments, with long paths cut
 * to their end, and for a lone Git command without the `-C` folder the step already shows.
 */
const commandLabel = (line: string, lone: boolean): string => {
  const tokens = rawTokens(line);
  const pieces: Array<{ text: string; spaced: boolean }> = [];
  let words: Array<{ word: string; spaced: boolean }> = [];
  const endCommand = () => {
    const start = words.findIndex(({ word }) => !isPlainAssignment(word));
    // A line of nothing but assignments sets variables, so it is shown as it is.
    const program = start === -1 ? words : words.slice(start);
    const git = lone && start !== -1 && basename(unquoted(program[0]?.word ?? "")) === "git";
    for (const { word, spaced } of git ? withoutGitFolder(program) : program)
      pieces.push({ text: shortPath(word), spaced });
    words = [];
  };
  for (const token of tokens) {
    if ("word" in token) words.push({ word: token.word, spaced: token.spaced });
    else {
      endCommand();
      pieces.push({ text: token.separator, spaced: token.spaced });
    }
  }
  endCommand();
  return pieces.map(({ text, spaced }, i) => (i > 0 && spaced ? ` ${text}` : text)).join("");
};

/** Private-use characters that stand in for a redaction marker, which holds spaces, while the line is read. */
const STANDIN_OPEN = "\uE000";
const STANDIN_CLOSE = "\uE001";
const STANDIN = new RegExp(`${STANDIN_OPEN}(\\d+)${STANDIN_CLOSE}`, "g");
const MARKER = /\[redacted: [^\]]+\]/g;

/** A label cut to `limit`, before any marker the cut would split, so a marker always reads whole. */
const shortenLabel = (label: string, limit: number) => {
  if (label.length <= limit) return label;
  let cut = limit - 1;
  for (const marker of label.matchAll(MARKER)) {
    if (marker.index < cut && marker.index + marker[0].length > cut) cut = marker.index;
  }
  return `${label.slice(0, cut).trimEnd()}…`;
};

/** A command's label, read after its secrets are redacted with each marker kept as one word. */
const redactedCommandLabel = (command: string, redact: (text: string) => string): string => {
  const markers: Array<string> = [];
  const masked = redact(command)
    .replaceAll(STANDIN_OPEN, "")
    .replaceAll(STANDIN_CLOSE, "")
    .replace(MARKER, (marker) => `${STANDIN_OPEN}${markers.push(marker) - 1}${STANDIN_CLOSE}`);
  const line = masked.split("\n").find((l) => l.trim() !== "") ?? "";
  // Only a command that is one simple command, on every line, is decided on the one folder On names.
  const lone = rawTokens(masked.trim()).every((token) => "word" in token);
  const label = commandLabel(line, lone).replace(STANDIN, (_, n: string) => markers[Number(n)] ?? "");
  return shortenLabel(label, COMMAND_LABEL_LIMIT);
};

/**
 * The shell command a call runs, as the Workbench's Terminal records it (ADR 023), or undefined for
 * any other call. Claude Code reports a command's output only when it ends, through its hooks.
 */
export const commandOf = (
  tool: string,
  input: Record<string, unknown>,
  folder: string,
  sandboxed: boolean,
  liveOutput = false,
): CommandStart | undefined =>
  tool === "Bash" && typeof input.command === "string"
    ? { line: input.command, folder, sandboxed, liveOutput }
    : undefined;

/** The words for a step of each tool that works on one file, and the input that names the file. */
const FILE_STEPS: Readonly<Record<string, { readonly verb: string; readonly key: string }>> = {
  Read: { verb: "Reading", key: "file_path" },
  Write: { verb: "Writing", key: "file_path" },
  Edit: { verb: "Editing", key: "file_path" },
  MultiEdit: { verb: "Editing", key: "file_path" },
  NotebookEdit: { verb: "Editing", key: "notebook_path" },
};

/**
 * Short words for a tool step, from the call's own arguments. Secrets are redacted with `redact`
 * before anything is shortened, so a cut never leaves part of one behind, and a command's label is
 * never cut inside a marker.
 */
export const toolLabel = (
  tool: string,
  input: Record<string, unknown>,
  redact: (text: string) => string = redactSecrets,
): string => {
  const file = (key: string) => {
    const path = text(input, key);
    return path === undefined ? "a file" : basename(redact(path));
  };
  const fileStep = FILE_STEPS[tool];
  if (fileStep !== undefined) return `${fileStep.verb} ${file(fileStep.key)}`;
  switch (tool) {
    case "Glob":
    case "Grep":
      return `Searching for ${shorten(redact(text(input, "pattern") ?? "files"))}`;
    case "Bash": {
      const command = text(input, "command");
      return `Running ${command === undefined ? "a command" : redactedCommandLabel(command, redact)}`;
    }
    case WEB_SEARCH_TOOL: {
      const query = text(input, "query");
      return query === undefined ? "Searching the web" : `Searching the web for ${shorten(redact(query))}`;
    }
    case "apply_patch": {
      const paths = patchPaths(input);
      const verb = patchChanges(input).every((change) => change.kind === "delete") ? "Deleting" : "Editing";
      return paths.length === 1 ? `${verb} ${basename(redact(paths[0] as string))}` : `${verb} ${paths.length} files`;
    }
    default:
      return `Using ${tool}`;
  }
};

/**
 * The narrowest of several verdicts, keeping the first on a tie, for one call's requests. An Ask is
 * high risk when any part that asks is, and grantable only when every part that asks is, with the
 * rules of each (ADR 015). An Allow names every grant that answered a part.
 */
export const narrowestVerdict = (verdicts: ReadonlyArray<PolicyVerdict>): PolicyVerdict | undefined => {
  const verdict = verdicts.reduce<PolicyVerdict | undefined>(
    (current, next) =>
      current === undefined ||
      (next.decision !== current.decision && narrowest(current.decision, next.decision) === next.decision)
        ? next
        : current,
    undefined,
  );
  if (verdict === undefined || verdict.decision === "deny") return verdict;
  if (verdict.decision === "allow") return { ...verdict, grantIds: [...new Set(verdicts.flatMap((v) => v.grantIds))] };
  const asking = verdicts.filter((v) => v.decision === "ask");
  const onceOnly = asking.some((v) => v.onceOnly);
  const grantable = !onceOnly && asking.every((v) => v.grantable);
  return {
    ...verdict,
    onceOnly,
    grantable,
    rules: grantable ? uniqueRules(asking.flatMap((v) => v.rules)) : [],
    grantIds: [],
  };
};
