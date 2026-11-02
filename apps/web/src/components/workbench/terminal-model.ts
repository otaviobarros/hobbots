import type { CommandRecord, NotKept } from "@hobbots/domain";

/**
 * What the Terminal shows of an Attempt's commands (ADR 023): each in the order it started, with
 * whether it succeeded and how long it took, and where its whole output is.
 */

/** The commands in the order they started; two that started together keep the order they were recorded in. */
export const commandsInOrder = (commands: ReadonlyArray<CommandRecord>): ReadonlyArray<CommandRecord> =>
  [...commands].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

/** How many commands ran, failed and are running now: the line above the list. */
export interface CommandTally {
  readonly total: number;
  readonly failed: number;
  readonly running: number;
}

export const tallyCommands = (commands: ReadonlyArray<CommandRecord>): CommandTally => ({
  total: commands.length,
  failed: commands.filter((each) => each.state === "failed").length,
  running: commands.filter((each) => each.state === "running").length,
});

/** How long a command ran: to its end, or to `now` while it runs. Null for one cut off with no end. */
export const commandDuration = (command: CommandRecord, now: Date): number | null => {
  const started = Date.parse(command.startedAt);
  if (command.endedAt !== null) return Date.parse(command.endedAt) - started;
  return command.state === "running" ? now.getTime() - started : null;
};

/**
 * Where a command's whole output is, once part of it was left out of its record: a log to open,
 * which may itself have left out its middle, or why there is none.
 */
export type WholeOutput =
  | { readonly kind: "log"; readonly totalBytes: number; readonly omittedBytes: number }
  | { readonly kind: "not-kept"; readonly reason: NotKept | null };

export const wholeOutput = (command: CommandRecord): WholeOutput =>
  command.log !== null && command.log.contentId !== null && command.logNotKept === null
    ? { kind: "log", totalBytes: command.log.totalBytes, omittedBytes: command.log.omittedBytes }
    : { kind: "not-kept", reason: command.logNotKept };

/** What the Terminal shows while a command runs: its output as it comes, or that it shows at the end. */
export const showsLive = (command: CommandRecord): boolean => command.state === "running" && command.liveOutput;

/** Whether any command still runs, so the Terminal's clock ticks. */
export const anyRunning = (commands: ReadonlyArray<CommandRecord>): boolean =>
  commands.some((each) => each.state === "running");
