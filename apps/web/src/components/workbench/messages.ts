import type { FileChange } from "@hobbots/domain";
import { formatCount, formatList, plural } from "../../lib/format.ts";
import type { Mark } from "./summary/summary-model.ts";
import type { UnavailableReason, WorkbenchTab } from "./workbench-model.ts";

/** Copy for the Workbench: one Task's full view (ADR 023, STD-I18N-001). */
export const messages = {
  askedBy: ({ chain }: { chain: ReadonlyArray<string> }) => `asked by ${chain.join(" → ")}`,
  you: "You",
  owner: ({ name }: { name: string }) => `Owner: ${name}`,
  worksIn: ({ names }: { names: ReadonlyArray<string> }) => `Works in ${formatList(names)}`,
  noFolders: "No folders",
  inSandbox: "In the sandbox",
  inSandboxLower: "in the sandbox",
  unsandboxed: "Unsandboxed",
  sandboxNotReady: "Needs the sandbox",
  sandboxHint: {
    on: "Commands run inside Hobbots' sandbox on the hub.",
    off: "Commands ran without Hobbots' sandbox on the hub.",
    unavailable: "The sandbox is not ready on this hub, so commands are blocked.",
  },
  attempts: "Attempts",
  attemptWord: "Attempt",
  attempt: ({ number }: { number: number }) => `Attempt ${formatCount(number)}`,
  tabs: "Workbench views",
  tab: {
    changes: "Changes",
    files: "Files",
    terminal: "Terminal",
    browser: "Browser",
  } satisfies Record<WorkbenchTab, string>,
  state: {
    live: "Live",
    history: "History",
    unavailable: "Unavailable",
    "not-used": "Not used in this task",
    "coming-soon": "Coming soon",
  },
  soon: "Soon",
  picker: {
    previous: "Previous file",
    next: "Next file",
    open: ({ label }: { label: string }) => `${label}: pick a file`,
    of: ({ index, total }: { index: number; total: number }) => `${formatCount(index)} of ${formatCount(total)}`,
  },
  unavailable: {
    cleared: "Details were cleared after 30 days.",
    "too-many-files": "This folder is too big to track changes.",
    "too-slow": "This folder took too long to scan, so its changes are not tracked.",
    unreadable: "Hobbots could not read this folder, so its changes are not tracked.",
    unread: "Hobbots could not read this task's records.",
  } satisfies Record<UnavailableReason, string>,
  tryAgain: "Try again",
  notUsed: {
    changes: ({ name }: { name: string }) => `${name} did not change any files in this task.`,
    files: ({ name }: { name: string }) => `${name} did not make or touch any files in this task.`,
    terminal: ({ name }: { name: string }) => `${name} did not use the terminal in this task.`,
  },
  comingSoon: "Watching a hob use a browser comes in a later update.",
  /** The docked Workbench of a whole Quest (ADR 027). */
  dock: {
    everyone: "Everyone · click a lane to filter",
    only: ({ name }: { name: string }) => `${name} only`,
    showEveryone: "Show every hob's work",
    by: ({ name }: { name: string }) => `, by ${name}`,
    resize: "Resize the Workbench",
    readFailed: "Hobbots could not read this quest's Workbench.",
    /** Why one hob's records for a tab cannot be shown, when the dock shows more than one hob. */
    hobUnavailable: ({ name, reason }: { name: string; reason: string }) => `${name}: ${reason}`,
  },
  terminal: {
    tally: ({ total, failed, running }: { total: number; failed: number; running: number }) =>
      [
        plural(total, { one: "1 command", other: `${formatCount(total)} commands` }),
        ...(failed > 0 ? [`${formatCount(failed)} failed`] : []),
        ...(running > 0 ? [`${formatCount(running)} running`] : []),
      ].join(" · "),
    readOnly: "A record of what ran. You cannot type here.",
    none: "No commands yet. They show here as they run.",
    state: {
      running: ({ time }: { time: string }) => `Running · ${time}`,
      failed: "Failed",
      uncertain: "Cut off",
    },
    /** A line of commands run one after another succeeds by its last one alone (#702). */
    finishedInSequence: "Finished · an earlier part may have failed",
    exitCode: ({ code }: { code: number }) => `exit code ${formatCount(code)}`,
    uncertain: "The turn ended while this ran, so whether it finished is not known.",
    ranIn: ({ folder }: { folder: string }) => `ran in ${folder}`,
    unsandboxed: "unsandboxed",
    started: ({ time }: { time: string }) => `started ${time}`,
    took: ({ time }: { time: string }) => `took ${time}`,
    omitted: ({ size }: { size: string }) => `${size} left out here`,
    terminals: "Terminals",
    screen: ({ name }: { name: string }) => `${name}'s terminal, read-only`,
    find: "Find in the terminal",
    findPlaceholder: "Find…",
    matches: ({ index, count }: { index: number; count: number }) =>
      index < 0 ? `${formatCount(count)} matches` : `${formatCount(index + 1)} of ${formatCount(count)}`,
    noMatches: "No matches",
    split: "◫ Split",
    unsplit: "▣ One at a time",
    splitHint: "Show every terminal side by side",
    unsplitHint: "Show one terminal at a time",
    /** A terminal tab's name: the hob's, and how its terminal stands when a command runs or failed. */
    tab: ({ name, mark }: { name: string; mark: "running" | "failed" | "idle" }) =>
      mark === "running" ? `${name}, running` : mark === "failed" ? `${name}, its last command failed` : name,
    fullLogs: "Full logs:",
    logOf: ({ command, size }: { command: string; size: string }) => `${command} (${size})`,
    waiting: "Nothing printed yet.",
    atEnd: "Its output shows when it ends.",
    missed: "Earlier output was not seen live. All of it shows here when the command ends.",
    openLog: ({ size }: { size: string }) => `Open the full log (${size})`,
    logCut: ({ size }: { size: string }) => `The log keeps the start and the end; ${size} in the middle was left out.`,
    noLog: {
      cleared: "The full log was cleared after 30 days.",
      "attempt-limit": "The full log was not kept: this task had kept all the logs it may.",
      other: "The full log could not be kept.",
    },
  },
  names: (names: ReadonlyArray<string>) => formatList(names),
  summary: {
    line: {
      notStarted: ({ name }: { name: string }) => `${name} has not started yet.`,
      asks: ({ name }: { name: string }) => `${name} is waiting on your answer in this lane.`,
      working: ({ name, number }: { name: string; number: number }) => `${name} is on attempt ${formatCount(number)}.`,
      waiting: ({ name, number }: { name: string; number: number }) =>
        `${name} is on attempt ${formatCount(number)} and is waiting before going on.`,
      ended: {
        failed: ({ number }: { number: number }) => `Attempt ${formatCount(number)} failed.`,
        cancelled: ({ number }: { number: number }) => `Attempt ${formatCount(number)} stopped before it finished.`,
        unresolved: ({ number }: { number: number }) =>
          `Hobbots asked attempt ${formatCount(number)} to stop but could not confirm that it did.`,
      },
      earlier: ({ count }: { count: number }) =>
        plural(count, {
          one: "An earlier try ended early.",
          other: `${formatCount(count)} earlier tries ended early.`,
        }),
    },
    happened: "What happened",
    nothingYet: ({ name }: { name: string }) => `${name} has not reported anything yet.`,
    nothingHappened: ({ name }: { name: string }) => `${name} did not report any progress in this attempt.`,
    mark: {
      done: "Done",
      failed: "Failed",
      waiting: "Waiting",
      running: "Working",
      next: "Next",
      cancelled: "Stopped",
      unresolved: "Stop not confirmed",
    } satisfies Record<Mark, string>,
    step: ({ index, total, title }: { index: number; total: number; title: string }) =>
      `Step ${formatCount(index)} of ${formatCount(total)}: ${title}`,
    member: ({ name, title }: { name: string; title: string }) => `${name}: ${title}`,
    tries: ({ count }: { count: number }) =>
      plural(count, { one: `${formatCount(count)} try`, other: `${formatCount(count)} tries` }),
    openStep: ({ title }: { title: string }) => `Open ${title} in Workbench`,
    lineLabel: ({ line, mark, title }: { line: string; mark: string; title: string }) =>
      `${line}, ${mark}. Open ${title} in Workbench`,
    milestone: ({ title }: { title: string }) => `Milestone: ${title}`,
    refused: ({ label }: { label: string }) => `${label}: refused`,
    refusedTold: ({ name, message }: { name: string; message: string }) => `Hobbots told ${name}: ${message}`,
    endedFailed: "This attempt failed.",
    endedStopped: "This attempt stopped before it finished.",
    endedUnresolved:
      "Hobbots asked this attempt to stop but could not confirm that it did, so its session may still be running.",
    endedWhy: ({ why }: { why: string }) => `Why: ${why}`,
    made: "What it made",
    nothingMade: ({ name }: { name: string }) => `${name} did not make or change anything in this attempt.`,
    madeSoFar: ({ name }: { name: string }) => `Nothing yet. What ${name} makes shows here as it happens.`,
    readingChanges: "Reading the changed files…",
    change: {
      added: "Added",
      edited: "Edited",
      deleted: "Deleted",
      moved: "Moved",
      link: "Link",
    } satisfies Record<FileChange["kind"], string>,
    seeChange: ({ path }: { path: string }) => `See the change to ${path} in Changes`,
    seeFile: ({ label }: { label: string }) => `See ${label} in Files`,
    movedFrom: ({ path }: { path: string }) => `from ${path}`,
    moreChanges: ({ count }: { count: number }) =>
      plural(count, {
        one: `See ${formatCount(count)} more changed file`,
        other: `See ${formatCount(count)} more changed files`,
      }),
    open: "Still open",
    nothingOpen: "Nothing is waiting on you or anyone else.",
    openUnread: "Hobbots could not read what is still open, so something may still be waiting.",
    tryAgain: "Try again",
    questionForYou: "A question for you",
    questionFor: ({ name }: { name: string }) => `A question for ${name}`,
    approval: "Waiting for your approval",
    uncommitted: "Uncommitted changes",
    answerInChat: "Answer in the chat",
    decideInChat: "Decide in the chat",
    waitingList: "What the hobs on this task are waiting on",
    noResult: "No result yet.",
    resultFrom: ({ number }: { number: number }) => `From attempt ${formatCount(number)}.`,
    tabs: "Open the other views",
    seeChanges: ({ count }: { count: number }) =>
      plural(count, {
        one: `See the ${formatCount(count)} changed file`,
        other: `See the ${formatCount(count)} changed files`,
      }),
    seeFiles: ({ count }: { count: number }) =>
      plural(count, { one: `See the ${formatCount(count)} file`, other: `See the ${formatCount(count)} files` }),
    seeTerminal: "See what ran in Terminal",
  },
};
