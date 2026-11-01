import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { operationDecision } from "@hobbots/agents";
import { narrowest, type PolicyDecision, type PolicyOperation, PRESET_DECISIONS, redactSecrets } from "@hobbots/domain";
import type { PolicyContext, PolicyRequest, PolicyVerdict } from "@hobbots/permissions";

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
 * The words of one simple command as they are read, with redirections left out. Only an unquoted,
 * unescaped operator is a redirection, so `rm '>' file` still names both files. A bare operator
 * (`> out`) also takes the next word, its target.
 */
const commandWords = () => {
  const words: Array<string> = [];
  let target = false;
  return {
    words,
    add: (word: string, quoted: boolean) => {
      const operator = quoted ? undefined : REDIRECTION.exec(word)?.[0];
      if (target) target = false;
      else if (operator === undefined) words.push(word);
      else target = operator === word;
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
  let quoted = false;
  const endWord = () => {
    if (started) current.add(word, quoted);
    word = "";
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
      else take(c);
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
const moveTo = (base: string, target: string | undefined, home: string, spelling: string, logical = false): string => {
  if (!isAbsolute(base)) return base;
  if (target === undefined || !isSettled(target)) return spelling;
  const expanded = expandHome(target, home);
  if (logical) return resolve(base, expanded);
  return isAbsolute(expanded) ? expanded : `${base}${sep}${expanded}`;
};

/** A path a command names, with `~` spelled out. */
const expandHome = (word: string, home: string) =>
  word === "~" ? home : word.startsWith("~/") ? `${home}${word.slice(1)}` : word;

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

// Git options that take a separate value before the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/** A `git push` as a Push request. Unknown remotes and branches are assumed the riskiest. */
const pushRequest = (args: ReadonlyArray<string>): PolicyRequest => {
  const positional = args.filter((a) => !a.startsWith("-"));
  const force = args.some(
    (a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror",
  );
  const refspec = positional[1];
  const branch = refspec
    ?.split(":")
    .at(-1)
    ?.replace(/^\+/, "")
    .replace(/^refs\/heads\//, "");
  return {
    _tag: "Push",
    remote: positional[0] ?? "origin",
    branch: branch ?? "(current branch)",
    force: force || refspec?.startsWith("+") === true,
    toDefaultBranch: branch === undefined || DEFAULT_BRANCHES.has(branch),
  };
};

/** The folder `git` works in after its `-C` options, and the index of its subcommand. */
const gitFolder = (args: ReadonlyArray<string>, folder: string, home: string): { folder: string; sub: number } => {
  let i = 0;
  let where = folder;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    if (args[i] === "-C") where = moveTo(where, args[i + 1], home, `git -C ${args[i + 1] ?? ""}`);
    i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1;
  }
  return { folder: where, sub: i };
};

const MAKE_CHDIR = new Set(["-C", "--directory"]);

/** The folder `make` runs in after its `-C` options. */
const makeFolder = (args: ReadonlyArray<string>, folder: string, home: string): string => {
  let where = folder;
  for (let i = 0; i < args.length; ) {
    const option = (args[i] as string).startsWith("-") ? readOption(args, i, MAKE_CHDIR) : { name: "", used: 1 };
    if (MAKE_CHDIR.has(option.name)) where = moveTo(where, option.value, home, `make -C ${option.value ?? ""}`);
    i += option.used;
  }
  return where;
};

const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink"]);

/** The requests one simple command makes in `folder`: running it, plus any Git, push or delete it is recognized as. */
const programRequests = (words: ReadonlyArray<string>, folder: string, home: string): ReadonlyArray<PolicyRequest> => {
  const [name, ...args] = words;
  if (name === undefined) return [];
  const program = basename(name);
  if (program === "git") {
    const git = gitFolder(args, folder, home);
    return args[git.sub] === "push"
      ? [pushRequest(args.slice(git.sub + 1))]
      : [{ _tag: "Command", operation: "local-git", cwd: git.folder }];
  }
  const run: PolicyRequest = {
    _tag: "Command",
    operation: "run-commands",
    cwd: program === "make" ? makeFolder(args, folder, home) : folder,
  };
  if (!DELETE_PROGRAMS.has(program)) return [run];
  const paths = args.filter((a) => !a.startsWith("-")).map((a) => expandHome(a, home));
  return [{ _tag: "Files", operation: "delete-files", paths: paths.length > 0 ? paths : ["."], cwd: folder }, run];
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
 * or the background.
 */
const folderFlow = (cwd: string, home: string) => {
  let flow: Flow = { ok: new Set([cwd]), fail: NONE };
  let separator: Separator | undefined;
  // The pipeline being run: what came before it and how it is joined. Its status is its last command's.
  let pipeline = { separator, before: flow, folders: flow.ok };
  const subshells: Array<typeof pipeline> = [];
  const start = () => {
    if (separator !== "|") pipeline = { separator, before: flow, folders: entering(flow, separator) };
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
        subshells.push(pipeline);
        flow = { ok: folders, fail: NONE };
        separator = undefined;
      } else if (next === ")") {
        pipeline = subshells.pop() ?? pipeline;
        finish({ ok: pipeline.folders, fail: pipeline.folders });
      } else separator = next;
    },
    /** The folder `words` runs in, moving the flow past it. `after` is the separator that follows it. */
    command: (words: ReadonlyArray<string>, after: Separator | undefined): string => {
      const inPipeline = separator === "|" || after === "|";
      const folders = start();
      const moves = DIRECTORY_COMMANDS.has(words[0] ?? "") && !inPipeline && after !== "&";
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
): ReadonlyArray<PolicyRequest> => {
  const requests: Array<PolicyRequest> = [];
  const add = (request: PolicyRequest) => {
    const key = JSON.stringify(request);
    if (!requests.some((r) => JSON.stringify(r) === key)) requests.push(request);
  };
  const tokens = commandLine(command);
  const folders = folderFlow(cwd, home);
  tokens.forEach((token, index) => {
    if ("separator" in token) {
      folders.separator(token.separator);
      return;
    }
    // A wrapper such as `command cd` still moves the shell, so the flow sees the unwrapped words.
    const preview = unwrap(token.words, cwd, home).words;
    const folder = folders.command(preview, separatorOf(tokens[index + 1]));
    const unwrapped = unwrap(token.words, folder, home);
    for (const request of programRequests(unwrapped.words, unwrapped.folder, home)) add(request);
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
): ReadonlyArray<PolicyRequest> | null => {
  const files = (operation: "read-files" | "edit-files", path: string | undefined): ReadonlyArray<PolicyRequest> => [
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

/**
 * Short words for a tool step, from the call's own arguments. Secrets are redacted with `redact`
 * before anything is shortened, so a cut never leaves part of one behind.
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
    case "Bash":
      return `Running ${shorten(redact(text(input, "command") ?? "a command").split("\n")[0] ?? "a command")}`;
    default:
      return `Using ${tool}`;
  }
};

/** The narrowest of several verdicts, keeping the first on a tie. */
export const narrowestVerdict = (verdicts: ReadonlyArray<PolicyVerdict>): PolicyVerdict | undefined =>
  verdicts.reduce<PolicyVerdict | undefined>(
    (current, next) =>
      current === undefined ||
      (next.decision !== current.decision && narrowest(current.decision, next.decision) === next.decision)
        ? next
        : current,
    undefined,
  );
