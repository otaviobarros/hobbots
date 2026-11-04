import { type CommandRecord, runsInSequence } from "@hobbots/domain";
import type { LiveOutput } from "../../api/workbench.ts";
import { formatBytes, formatDuration } from "../../lib/format.ts";
import { formatTime } from "../../lib/time.ts";
import { link, printable, RESET, style } from "../terminal/ansi.ts";
import { messages } from "./messages.ts";
import { commandDuration, wholeOutput } from "./terminal-model.ts";

const copy = messages.terminal;

/** What a hob's terminal replays: its commands in the order they started, with what they printed. */
export interface Scrollback {
  /** The hob's name, which its prompt starts with. */
  readonly name: string;
  readonly commands: ReadonlyArray<CommandRecord>;
  /** What each running command printed so far, by command. */
  readonly live: Readonly<Record<string, LiveOutput>>;
}

/** Where a folded command's whole log is, by its Attempt and id. */
export type LogUrl = (command: CommandRecord) => string;

/** The prompt's user: the hob's name in lower case, with a dash for each run of spaces. */
const promptUser = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-") || "hob";

/** The prompt's host: the last name in the folder's path, as a shell's `\W` shows it. */
const promptFolder = (folder: string) => folder.split("/").filter(Boolean).at(-1) ?? "/";

/** `quill@site $ pnpm build`, a command of more than one line going on after a dim `>`. */
const promptLines = (name: string, command: CommandRecord): ReadonlyArray<string> => {
  const [first = "", ...rest] = command.command.split("\n");
  const prompt = `${style.green(`${promptUser(name)}@${promptFolder(command.folder)}`)} ${style.dim("$")} `;
  return [prompt + style.bold(first), ...rest.map((line) => `${style.dim(">")} ${style.bold(line)}`)];
};

/** Printed text as lines, its colors ended after the last; nothing when it printed nothing. */
const printedLines = (text: string): ReadonlyArray<string> => {
  if (text === "") return [];
  const lines = printable(text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  return [...lines.slice(0, -1), `${lines.at(-1) ?? ""}${RESET}`];
};

/** The dim line between a long output's start and end: what was left out and where all of it is. */
const foldLine = (command: CommandRecord, omittedBytes: number, logUrl: LogUrl): string => {
  const whole = wholeOutput(command);
  const where =
    whole.kind === "log"
      ? link(logUrl(command), copy.openLog({ size: formatBytes(whole.totalBytes) }))
      : copy.noLog[whole.reason === "cleared" || whole.reason === "attempt-limit" ? whole.reason : "other"];
  return style.dim(`··· ${copy.omitted({ size: formatBytes(omittedBytes) })} · ${where} ···`);
};

/** What a command printed: as it comes while it runs, else its record's start and end once it ended. */
const outputLines = (command: CommandRecord, live: LiveOutput | undefined, logUrl: LogUrl, now: Date) => {
  if (command.state === "running") {
    const duration = formatDuration(commandDuration(command, now) ?? 0);
    if (!command.liveOutput) return [style.dim(`● ${copy.state.running({ time: duration })} · ${copy.atEnd}`)];
    const missed = live?.missed === true ? [style.dim(copy.missed)] : [];
    const text = live?.text ?? "";
    return text === "" ? [...missed, style.dim(copy.waiting)] : [...missed, ...printedLines(text)];
  }
  const output = command.output;
  if (output === null) return [];
  if (output.omittedBytes === 0) return printedLines(output.head);
  return [...printedLines(output.head), foldLine(command, output.omittedBytes, logUrl), ...printedLines(output.tail)];
};

/**
 * The dim line after a command that ended: how it ended, then where, in or out of the sandbox,
 * when and for how long. A failure leads with its exit code in red; a line of commands that exited
 * 0 only "Finished", since an earlier one may have failed (#702); one cut off says so.
 */
const endLine = (command: CommandRecord, now: Date): string => {
  const duration = commandDuration(command, now);
  const where = [
    copy.ranIn({ folder: command.folder }),
    command.sandboxed ? messages.inSandboxLower : style.red(copy.unsandboxed),
    copy.started({ time: formatTime(command.startedAt) }),
    ...(duration === null ? [] : [copy.took({ time: formatDuration(duration) })]),
  ];
  const meta = where.map((part) => style.dim(part)).join(style.dim(" · "));
  if (command.state === "failed") {
    const code = command.exitCode === null ? copy.state.failed : copy.exitCode({ code: command.exitCode });
    return `${style.red(`✗ ${code}`)}${style.dim(" · ")}${meta}`;
  }
  if (command.state === "uncertain") {
    return `${style.yellow(`? ${copy.state.uncertain} · ${copy.uncertain}`)}${style.dim(" · ")}${meta}`;
  }
  if (runsInSequence(command.command)) return `${style.yellow(copy.finishedInSequence)}${style.dim(" · ")}${meta}`;
  return `${style.dim("✓ ")}${meta}`;
};

/**
 * A hob's whole scrollback, as a terminal prints it (#908): each command's prompt line, what it
 * printed with its colors, and how it ended. A running command ends it, with its output as it
 * comes or its clock while its runtime reports output only at the end. Lines are joined by line
 * feeds with none after the last, so a running clock is the last line and can be written in place.
 */
export const transcript = (scrollback: Scrollback, logUrl: LogUrl, now: Date): string =>
  scrollback.commands
    .flatMap((command) => [
      ...promptLines(scrollback.name, command),
      ...outputLines(command, scrollback.live[command.id], logUrl, now),
      ...(command.state === "running" ? [] : [endLine(command, now)]),
    ])
    .join("\n");
