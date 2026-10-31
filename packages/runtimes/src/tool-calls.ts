import { basename } from "node:path";
import { operationDecision } from "@hobbots/agents";
import { narrowest, type PolicyDecision, type PolicyOperation, PRESET_DECISIONS } from "@hobbots/domain";
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

/** One shell command line split into simple commands, each as its words. Quotes are honored; anything subtler is not. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: predates the complexity limit (STD-ARCH-012). Split it before adding more branches.
export const simpleCommands = (command: string): ReadonlyArray<ReadonlyArray<string>> => {
  const commands: Array<Array<string>> = [];
  let words: Array<string> = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      started = true;
    } else if (c === " " || c === "\t") endWord();
    else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") endCommand();
    else {
      word += c;
      started = true;
    }
  }
  endCommand();
  return commands;
};

/** Drops leading `VAR=value` assignments and wrappers that run the next word as the command. */
const commandWords = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i++;
  while (i < words.length && ["env", "command", "exec", "nohup", "time"].includes(words[i] as string)) i++;
  return words.slice(i);
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

/** The requests one shell command makes: running it, plus any Git, push or delete it is recognized as. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: predates the complexity limit (STD-ARCH-012). Split it before adding more branches.
export const commandRequests = (command: string, cwd: string): ReadonlyArray<PolicyRequest> => {
  const requests: Array<PolicyRequest> = [];
  const add = (request: PolicyRequest) => {
    const key = JSON.stringify(request);
    if (!requests.some((r) => JSON.stringify(r) === key)) requests.push(request);
  };
  for (const raw of simpleCommands(command)) {
    const words = commandWords(raw);
    const [name, ...args] = words;
    if (name === undefined) continue;
    const program = basename(name);
    if (program === "git") {
      let i = 0;
      while (i < args.length && (args[i] as string).startsWith("-"))
        i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1;
      const sub = args[i];
      if (sub === "push") add(pushRequest(args.slice(i + 1)));
      else add({ _tag: "Command", operation: "local-git", cwd });
      continue;
    }
    if (program === "rm" || program === "rmdir" || program === "unlink") {
      const paths = args.filter((a) => !a.startsWith("-"));
      add({ _tag: "Files", operation: "delete-files", paths: paths.length > 0 ? paths : ["."], cwd });
    }
    add({ _tag: "Command", operation: "run-commands", cwd });
  }
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

/** Short words for a tool step, from the call's own arguments. */
export const toolLabel = (tool: string, input: Record<string, unknown>): string => {
  const file = (key: string) => {
    const path = text(input, key);
    return path === undefined ? "a file" : basename(path);
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
      return `Searching for ${shorten(text(input, "pattern") ?? "files")}`;
    case "Bash":
      return `Running ${shorten(text(input, "command")?.split("\n")[0] ?? "a command")}`;
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
