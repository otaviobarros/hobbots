import { basename } from "node:path";

/**
 * The hub's command reader of ADR 015: whether a command line can be saved as a rule, and its
 * literal words when it can. Only commands the card can show completely are grantable, so a rule
 * never allows more than the user saw. The reader is deliberately strict: anything it is not sure
 * the shell passes exactly as written makes the command unreadable, which offers Allow once only.
 */

/** Characters a word may hold outside quotes and still be passed exactly as written. */
const LITERAL = /^[A-Za-z0-9_@%+=:,./-]$/;

/**
 * Programs that change where the rest runs, run other words as a command, or start a shell, so
 * their words alone do not say what runs (ADR 015).
 */
const WRAPPERS = new Set([
  "eval",
  "exec",
  "source",
  ".",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "xargs",
  "env",
  "sudo",
  "doas",
  "su",
  "watch",
  "nohup",
  "time",
  "timeout",
  "nice",
  "command",
  "builtin",
]);

/**
 * Programs that move the rest of the line to another folder. A line with one reads as nothing, so
 * none of its commands, and none of the paths they name, is granted against the wrong folder.
 */
const FOLDER_CHANGES = new Set(["cd", "pushd", "popd"]);

/**
 * Shell keywords and builtins that make the line more than a list of simple commands: conditionals,
 * loops, groups, and commands that run a string or change how later words run. The reader does not
 * follow them, so a line that has one reads as nothing.
 */
const CONTROL = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "{",
  "}",
  "[[",
  "]]",
  "!",
  "trap",
  "alias",
  "unalias",
  "enable",
]);

/** One simple command of a command line: its literal words, or null when it cannot be granted. */
export type ReadCommand = ReadonlyArray<string> | null;

interface Reading {
  readonly commands: Array<Array<string>>;
  words: Array<string>;
  word: string;
  started: boolean;
}

const endWord = (r: Reading) => {
  if (r.started) r.words.push(r.word);
  r.word = "";
  r.started = false;
};

const endCommand = (r: Reading) => {
  endWord(r);
  if (r.words.length > 0) r.commands.push(r.words);
  r.words = [];
};

/** The index after a quoted part starting at `start`, adding its text to the word; -1 when unreadable. */
const readQuoted = (line: string, start: number, r: Reading): number => {
  const quote = line[start];
  const end = line.indexOf(quote as string, start + 1);
  if (end === -1) return -1;
  const text = line.slice(start + 1, end);
  // Inside double quotes the shell still expands `$`, backticks and backslashes.
  if (quote === '"' && /[$`\\!]/.test(text)) return -1;
  r.word += text;
  r.started = true;
  return end + 1;
};

/** The index after an operator that separates commands at `i`, or -1 when `i` holds none. */
const separatorEnd = (line: string, i: number): number => {
  const c = line[i];
  const next = line[i + 1];
  if (c === "\n" || c === ";") return i + 1;
  if (c === "|") return next === "|" ? i + 2 : i + 1;
  if (c === "&" && next === "&") return i + 2;
  return -1;
};

/** Splits a command line into simple commands of literal words, or null when any part is unreadable. */
const split = (line: string): Array<Array<string>> | null => {
  const r: Reading = { commands: [], words: [], word: "", started: false };
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === "'" || c === '"') {
      i = readQuoted(line, i, r);
      if (i === -1) return null;
      continue;
    }
    const separator = separatorEnd(line, i);
    if (separator !== -1) {
      endCommand(r);
      i = separator;
      continue;
    }
    if (c === " " || c === "\t") endWord(r);
    // Globs, `~`, `$`, backticks, redirections, a lone `&`, `#`, parentheses and backslashes.
    else if (!LITERAL.test(c)) return null;
    else {
      r.word += c;
      r.started = true;
    }
    i++;
  }
  endCommand(r);
  return r.commands;
};

/** A simple command's words when it can be granted: no leading assignment and no `=` program. */
const grantable = (words: ReadonlyArray<string>): boolean => {
  const program = words[0];
  // `VAR=value cmd`, and zsh's `=cmd`, which expands to a path.
  return program !== undefined && !program.includes("=");
};

/**
 * Reads a command line into its simple commands, split at `&&`, `||`, `;`, `|` and newlines, each
 * with its literal words after quotes are removed, or null where it cannot be granted. Null for
 * the whole line when any part of it is unreadable, since the parts could not be told apart safely,
 * or when any of its commands is `cd`, `pushd`, `popd` or a wrapper such as `command`, `env` or
 * `sudo`, since the line's commands may then run elsewhere or as something else.
 */
export const readCommandLine = (line: string): ReadonlyArray<ReadCommand> | null => {
  const commands = split(line);
  if (commands === null || commands.length === 0) return null;
  // A wrapper runs later words as a command, `command cd` and `env -C` included, and a folder change
  // moves what follows. Either, after any leading assignments, makes the whole line read as nothing.
  // Shell keywords such as `if` and `then`, and a `cd`-like word anywhere, do the same: only a plain
  // list of simple commands is read.
  const opaque = (words: ReadonlyArray<string>) => {
    const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (program === undefined) return false;
    const name = basename(program);
    return (
      FOLDER_CHANGES.has(name) ||
      WRAPPERS.has(name) ||
      CONTROL.has(program) ||
      words.some((word) => FOLDER_CHANGES.has(basename(word)))
    );
  };
  if (commands.some(opaque)) return null;
  return commands.map((words) => (grantable(words) ? words : null));
};
