import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { operationDecision } from "@hobbots/agents";
import { narrowest, type PolicyDecision, type PolicyOperation, PRESET_DECISIONS, redactSecrets } from "@hobbots/domain";
import {
  type PolicyContext,
  type PolicyRequest,
  type PolicyVerdict,
  readCommandLine,
  uniqueRules,
} from "@hobbots/permissions";

/** A request a runtime tool call becomes: every kind but a Charm's, which the hub makes itself. */
type ToolRequest = Exclude<PolicyRequest, { readonly _tag: "GitHub" }>;

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
 * The tools offered to the runtime this turn. A tool whose operations are all denied is left out,
 * so the model does not try it. Bash also needs the sandbox, and since a command reads and writes
 * the folders without asking file by file, it is offered only when the hob may do both without
 * asking. Every call is still decided one by one.
 */
export const offeredTools = (context: Pick<PolicyContext, "preset" | "hob" | "restrictions" | "sandbox">) => {
  const open = (...operations: ReadonlyArray<PolicyOperation>) =>
    operations.some((operation) => operationDecision(context, operation) !== "deny");
  const free = (...operations: ReadonlyArray<PolicyOperation>) =>
    operations.every((operation) => operationDecision(context, operation) === "allow");
  return CLAUDE_CODE_TOOLS.filter((tool) => {
    switch (tool) {
      case "Read":
      case "Glob":
      case "Grep":
        return open("read-files");
      case "Bash":
        return (
          context.sandbox !== "unavailable" && open("run-commands", "local-git") && free("read-files", "edit-files")
        );
      default:
        return open("edit-files");
    }
  });
};

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

/** Drops leading `VAR=value` assignments and wrappers, in any order, so the real program is classified. */
const unwrap = (words: ReadonlyArray<string>, folder: string, home: string): Unwrapped => {
  let current: Unwrapped = { words, folder };
  for (;;) {
    const [first, ...rest] = current.words;
    if (first === undefined) return current;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      current = { words: rest, folder: current.folder };
      continue;
    }
    const wrapper = WRAPPERS.get(basename(first));
    if (wrapper === undefined) return current;
    current = skipWrapper(rest, wrapper, current.folder, home);
  }
};

// Git options that take a value before the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

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
const pushRequests = (args: ReadonlyArray<string>, cwd: string, literal: boolean): ReadonlyArray<ToolRequest> => {
  const options = args.filter((a) => a.startsWith("-"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const force = options.some(isForce);
  const remote = positional[0] ?? "origin";
  const exact = literal && options.every((a) => PLAIN_PUSH_OPTIONS.has(a));
  const push = (branch: string, forced: boolean, toDefaultBranch: boolean, exactPush: boolean): ToolRequest => ({
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
 * folder it runs in always is.
 */
const gitFolders = (
  args: ReadonlyArray<string>,
  folder: string,
  home: string | null,
): { folders: ReadonlyArray<string>; sub: number } => {
  let i = 0;
  let where = folder;
  const named: Array<{ name: "--git-dir" | "--work-tree"; value: string | undefined }> = [];
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const option = readOption(args, i, GIT_VALUE_OPTIONS);
    if (option.name === "-C") where = moveTo(where, option.value, home, `git -C ${option.value ?? ""}`);
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
  return { folders: [...new Set(folders)], sub: i };
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
): ReadonlyArray<ToolRequest> => {
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
  const run: ToolRequest = {
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
export const commandRequests = (command: string, cwd: string, home: string = homedir()): ReadonlyArray<ToolRequest> => {
  const requests: Array<ToolRequest> = [];
  const add = (request: ToolRequest) => {
    const key = JSON.stringify(request);
    if (!requests.some((r) => JSON.stringify(r) === key)) requests.push(request);
  };
  const tokens = commandLine(command);
  const folders = folderFlow(cwd, home);
  // The reader splits a line it can read where this does, so its commands line up one to one.
  const read = readCommandLine(command);
  const simple = tokens.filter((token) => "words" in token).length;
  const literal = read !== null && read.length === simple ? read : null;
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
    for (const request of programRequests(unwrapped.words, unwrapped.folder, home, literalWords)) add(request);
  });
  if (requests.length === 0) add({ _tag: "Command", operation: "run-commands", cwd });
  return requests;
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
    default:
      return null;
  }
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
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
  if (match === null) return false;
  const [, name = "", value = ""] = match;
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
  switch (tool) {
    case "Read":
      return `Reading ${file("file_path")}`;
    case "Write":
      return `Writing ${file("file_path")}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${file("file_path")}`;
    case "NotebookEdit":
      return `Editing ${file("notebook_path")}`;
    case "Glob":
    case "Grep":
      return `Searching for ${shorten(redact(text(input, "pattern") ?? "files"))}`;
    case "Bash": {
      const command = text(input, "command");
      return `Running ${command === undefined ? "a command" : redactedCommandLabel(command, redact)}`;
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
