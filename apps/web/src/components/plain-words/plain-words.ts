import {
  type CommandRecord,
  exactAction,
  type FileChangeKind,
  type PolicyOperation,
  type ReplyStep,
} from "@hobbots/domain";
import { operationLabel } from "../../lib/reply-steps.ts";
import { messages } from "./messages.ts";

/**
 * What a hob did or wants to do, in everyday words, for people who do not read shell commands
 * (ADR 027). Everything here reads the records the hub keeps; the exact commands stay in the
 * Workbench Terminal and in an approval's code, which these words never replace.
 */

/** How a step a lane shows in words went. */
export type StepOutcome = "done" | "failed" | "running" | "blocked" | "unknown";

/** A file's own name, without its folders: `docs/copy.md` reads `copy.md`. */
const fileName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
};

/** A file a hob changed, as a lane says it: "Created copy.md". */
export const changeLine = (kind: FileChangeKind, path: string): string => {
  const name = fileName(path);
  switch (kind) {
    case "added":
      return messages.created({ name });
    case "deleted":
      return messages.deleted({ name });
    case "moved":
      return messages.moved({ name });
    default:
      return messages.updated({ name });
  }
};

/** The files a call names: up to two by name, then how many more. */
const fileList = (targets: ReadonlyArray<string>): string => {
  const names = [...new Set(targets.map(fileName))];
  if (names.length === 0) return messages.someFiles;
  return messages.files(names.slice(0, 2), Math.max(0, names.length - 2));
};

/** What a command does, by the kind of thing it runs, or `routine` for one that only looks around or moves files. */
export type CommandSense =
  | { readonly kind: "routine" }
  | { readonly kind: "script" | "packageScript"; readonly name: string }
  | { readonly kind: "tests" | "build" | "lint" | "install" | "commit" | "git" | "other" };

/**
 * Commands that only look around, print or arrange files. A lane leaves them out: what they read
 * is not news, and a file they write, move or delete shows as the file change it made.
 */
const ROUTINE = new Set([
  "ls",
  "cat",
  "pwd",
  "echo",
  "printf",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "chmod",
  "chown",
  "mkdir",
  "cd",
  "wc",
  "test",
  "[",
  "which",
  "file",
  "stat",
  "sed",
  "awk",
  "sort",
  "uniq",
  "true",
  "false",
  "touch",
  "cp",
  "mv",
  "rm",
  "rmdir",
  "unlink",
  "ln",
  "diff",
  "tree",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "date",
  "sleep",
  "xxd",
  "od",
  "cut",
  "tr",
  "tee",
  "env",
  "export",
  "set",
  "type",
  "command",
  "less",
  "more",
  "du",
  "df",
  "whoami",
  "uname",
  "exit",
  "jq",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "source", "."]);
const RUNNERS = new Set(["node", "python", "python3", "ruby", "deno", "tsx", "perl", "php"]);
const PACKAGES = new Set(["pnpm", "npm", "yarn", "bun", "npx"]);
const PREFIXES = new Set(["sudo", "time", "exec", "nohup"]);
const GIT_LOOKS = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "remote", "ls-files", "blame"]);

/** A command line without the bodies of its here-documents, which are a file's text, not commands. */
const withoutHeredocs = (command: string): string =>
  command.replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, "$1");

/** The words of a simple command, without the variables it sets first or `sudo` and the like. */
const wordsOf = (segment: string): Array<string> => {
  const parts = segment
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "" && !/^[A-Za-z_]\w*=/.test(word));
  while (parts[0] !== undefined && PREFIXES.has(parts[0])) parts.shift();
  return parts;
};

/** What a package manager runs: the tests, a build, an install or a script of the project's. */
const packageSense = (tool: string, args: ReadonlyArray<string>): CommandSense => {
  const [first, second] = args;
  const name = first === "run" || first === "exec" ? second : first;
  if (name === undefined) return { kind: tool === "npx" ? "other" : "install" };
  if (["install", "i", "add", "ci"].includes(name)) return { kind: "install" };
  if (/^test/.test(name) || name === "vitest" || name === "jest") return { kind: "tests" };
  if (name === "build") return { kind: "build" };
  if (name === "lint" || name === "biome" || name === "eslint") return { kind: "lint" };
  return { kind: "packageScript", name };
};

/** What a git command does, or null for one that only looks. */
const gitSense = (args: ReadonlyArray<string>): CommandSense | null => {
  const sub = args[0];
  if (sub !== undefined && GIT_LOOKS.has(sub)) return null;
  return { kind: sub === "commit" ? "commit" : "git" };
};

/** What one simple command runs, or null when it only looks around. */
const senseOf = (segment: string): CommandSense | null => {
  const [head, ...rest] = wordsOf(segment);
  if (head === undefined) return null;
  const base = fileName(head);
  if (ROUTINE.has(base)) return null;
  const args = rest.filter((word) => !word.startsWith("-"));
  if (SHELLS.has(base) || RUNNERS.has(base)) {
    const file = args[0];
    return file === undefined || rest.includes("-c") ? { kind: "other" } : { kind: "script", name: fileName(file) };
  }
  if (PACKAGES.has(base)) return packageSense(base, args);
  if (base === "git") return gitSense(args);
  // A path to a program, such as `./check.sh`, runs that script.
  return head.includes("/") ? { kind: "script", name: base } : { kind: "other" };
};

/** What a command line does: the first part of it that does more than look around. */
export const commandSense = (command: string): CommandSense => {
  for (const segment of withoutHeredocs(command).split(/&&|\|\||;|\||\n/)) {
    const sense = senseOf(segment);
    if (sense !== null) return sense;
  }
  return { kind: "routine" };
};

const said = (words: typeof messages.ran, sense: Exclude<CommandSense, { kind: "routine" }>): string =>
  "name" in sense ? words[sense.kind]({ name: sense.name }) : words[sense.kind];

/** A command a hob ran, as a lane says it, or null for one that only looked around. */
export const commandLine = (record: CommandRecord): { readonly text: string; readonly outcome: StepOutcome } | null => {
  const sense = commandSense(record.command);
  if (sense.kind === "routine") return null;
  switch (record.state) {
    case "running":
      return { text: said(messages.running, sense), outcome: "running" };
    case "succeeded":
      return { text: said(messages.ran, sense), outcome: "done" };
    case "failed":
      return { text: said(messages.ran, sense), outcome: "failed" };
    case "uncertain":
      return { text: said(messages.ran, sense), outcome: "unknown" };
  }
};

/** The command a step's label names, as "Running pnpm test" says it. */
const labelCommand = (label: string): string => label.replace(/^Running\s+/, "");

/**
 * What a call wants to do, as the rest of "Ada asks to …", in lower case: "delete scratch.txt",
 * "run check.sh". A call on files names them and a command says what it runs; any other says what
 * the Permissions tab calls it. `command` is the command line of a call that runs one.
 */
export const actionPhrase = (operation: PolicyOperation, targets: ReadonlyArray<string>, command = ""): string => {
  switch (operation) {
    case "read-files":
    case "edit-files":
    case "delete-files":
    case "outside-folders":
      return messages.action[operation]({ what: fileList(targets) });
    case "run-commands": {
      const sense = commandSense(command);
      return sense.kind === "routine" ? messages.command.other : said(messages.command, sense);
    }
    default: {
      const label = operationLabel(operation);
      return label.charAt(0).toLowerCase() + label.slice(1);
    }
  }
};

/** What an approval asks to do, in the words of `actionPhrase`. */
export const approvalAction = (approval: {
  readonly operation: PolicyOperation;
  readonly targets: ReadonlyArray<string>;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly label: string;
}): string => actionPhrase(approval.operation, approval.targets, exactAction(approval));

/** The same, starting with a capital, as a question or a line on its own. */
export const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What a running step does, as a lane says it under "Working". */
export const stepDoing = (step: ReplyStep): string => {
  const call = step.call;
  // A step without a call is the hob thinking or using a Task tool, whose labels are already words,
  // or a command a runtime reported without one.
  if (call === undefined) {
    if (!step.label.startsWith("Running ")) return step.label;
    const sense = commandSense(labelCommand(step.label));
    return sense.kind === "routine" ? messages.looking : said(messages.running, sense);
  }
  switch (call.operation) {
    case "run-commands": {
      const sense = commandSense(labelCommand(step.label));
      return sense.kind === "routine" ? messages.looking : said(messages.running, sense);
    }
    case "read-files":
    case "edit-files":
    case "delete-files":
      return messages.doing[call.operation]({ what: fileList(call.targets) });
    default:
      return messages.doing[call.operation];
  }
};

/** A step that was stopped before it ran, as a lane says it. */
export const blockedLine = (step: ReplyStep): string => {
  const call = step.call;
  const by = step.decidedBy ?? "policy";
  if (call === undefined) return messages.blocked[by]({ what: messages.command.other });
  if (call.operation === "outside-folders" && by !== "user") return messages.blocked.outside;
  return messages.blocked[by]({ what: actionPhrase(call.operation, call.targets, labelCommand(step.label)) });
};
