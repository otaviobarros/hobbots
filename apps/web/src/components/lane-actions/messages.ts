import { formatCount, formatList } from "../../lib/format.ts";

/** Copy for acting in each hob's work in a quest (STD-I18N-001). */
export const messages = {
  menu: ({ name }: { name: string }) => `${name}'s task menu`,
  menuOf: ({ name }: { name: string }) => `${name}'s task`,
  showInWorkbench: "Show in the Workbench",
  retry: "Retry",
  /** Retry on stuck work when the lane holds more than one Task with some. */
  retryTask: ({ title }: { title: string }) => `Retry “${title}”`,
  retrying: "Retrying…",
  reassign: "Reassign…",
  cancelTask: "Cancel task…",
  cancelQuest: "Cancel quest…",
  cancelStep: "Cancel a step…",
  cancelWhich: "Cancel which task?",
  pin: "Pin quest",
  unpin: "Unpin quest",
  /** What cancelling the Quest from the lead's lane keeps. */
  cancelKeeps: ({ name }: { name: string }) => `Cancels every task under it. ${name} keeps what is done.`,
  reassignTo: ({ title }: { title: string }) => `Reassign “${title}” to`,
  noOneElse: "No other hob can take this task.",
  back: "Back",
  /** Take over (#1449): the Task's files and branches move to you. */
  takeOver: "Take over its files and branches",
  takeOverKeeps: ({ name }: { name: string }) =>
    `${name} keeps working, but Hobbots refuses its writes to them until the task ends.`,
  takingOver: "Taking over its files and branches…",
  /** What you took over of a Task, as the claims register holds it. */
  taken: ({ claims }: { claims: ReadonlyArray<{ readonly scope: string; readonly key: string }> }) =>
    `Yours now: ${formatList(claims.map((claim) => (claim.scope === "path" ? claim.key : claim.scope === "branch" ? `branch ${claim.key}` : `number ${claim.key}`)))}. Hobbots refuses the hob's writes to them.`,
  takeOverFailed: "Taking over didn't go through. Hobbots may be reconnecting.",
  claimsUnread: "Hobbots couldn't read which files and branches this task holds.",
  claimsRetry: "Try again",
  /** The attempt picker in a lane's header: "Try 1 ✗ · 2". */
  tries: ({ name }: { name: string }) => `${name}'s attempts`,
  try: "Try",
  tryNumber: ({ number }: { number: number }) => formatCount(number),
  tryLabel: ({ number, failed }: { number: number; failed: boolean }) =>
    failed ? `Attempt ${formatCount(number)}, failed` : `Attempt ${formatCount(number)}`,
  failedMark: "✗",
  asks: ({ name }: { name: string }) => `${name} asks you`,
  asksMark: "●",
  /** Who passed the question up, from the hob that asked to you, and when it asked. */
  passedUp: ({ chain, when }: { chain: ReadonlyArray<string>; when: string }) =>
    `Passed up by ${[...chain, "you"].join(" → ")} · asked ${when}`,
  failed: ({ name }: { name: string }) => `${name}'s task failed`,
  failedTitle: ({ title }: { title: string }) => `${title} failed`,
  stopped: "✗ Stopped",
  stoppedWhy: "It stopped before it finished, and the hub recorded no reason.",
};
