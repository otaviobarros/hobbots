import { isInProgress, type Message, stepCommand, waitedSteps } from "@hobbots/domain";

/** How long a wait may run before the hint says the command may never end on its own (#1056). */
export const LONG_WAIT_MS = 10 * 60_000;

/** The longest command the hint names; the step shows it whole. */
const COMMAND_MAX = 32;

/** A reply that waits only on commands its hob started, once the hob has answered (#1056). */
export interface ReplyWait {
  /** The commands, as their steps name them, cut for the hint. */
  readonly commands: ReadonlyArray<string>;
  /** When the first of them started (ISO 8601), or null when no step says. */
  readonly since: string | null;
}

/** A command cut to the length the hint names it at. */
export const shortCommand = (command: string): string =>
  command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX - 1)}…` : command;

/** What a reply in progress waits on, or null while its hob is still at work, or it has ended. */
export const replyWait = (message: Pick<Message, "status" | "steps"> | undefined): ReplyWait | null => {
  if (message === undefined || (message.status !== "streaming" && message.status !== "stopping")) return null;
  const steps = waitedSteps(message.steps);
  if (steps.length === 0) return null;
  const starts = steps.flatMap((step) => (step.startedAt === undefined ? [] : [step.startedAt])).sort();
  return { commands: steps.map((step) => shortCommand(stepCommand(step))), since: starts[0] ?? null };
};

/**
 * What the composer shows for the thread's reply, one type per mode (STD-REACT-029), so no screen can
 * pass a combination that cannot happen, such as stopping while no reply runs. `replying` while the
 * hob is at work; `waiting` once it has answered and only commands it started keep the reply open
 * (#1056); `stopping` from Stop until the runtime confirms the turn ended, with what it still waits
 * on.
 */
export type ReplyRun =
  | { readonly mode: "idle" }
  | { readonly mode: "replying" }
  | { readonly mode: "waiting"; readonly wait: ReplyWait }
  | { readonly mode: "stopping"; readonly wait: ReplyWait | null };

const NO_REPLY: ReplyRun = { mode: "idle" };

/**
 * The composer's mode from the thread's reply in progress, as the hub recorded it, and whether you
 * asked to stop it and the hub has not answered yet.
 */
export const replyRun = (reply: Pick<Message, "status" | "steps"> | undefined, stopAsked: boolean): ReplyRun => {
  if (reply === undefined || !isInProgress(reply.status)) return NO_REPLY;
  const wait = replyWait(reply);
  if (stopAsked || reply.status === "stopping") return { mode: "stopping", wait };
  return wait === null ? { mode: "replying" } : { mode: "waiting", wait };
};

/** Whether a reply runs, so Send queues behind it and Stop shows. */
export const replyRuns = (run: ReplyRun): boolean => run.mode !== "idle";

/** Whole minutes from `since` to `now`, never below zero. */
export const minutesSince = (since: string | null, now: Date): number =>
  since === null ? 0 : Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000));

/** Whole minutes between two times (ISO 8601), never below zero. */
export const minutesBetween = (from: string | undefined, to: string | undefined): number | null =>
  from === undefined || to === undefined ? null : Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60_000));
