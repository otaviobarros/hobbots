import type { CheckpointKind } from "@hobbots/domain";
import { formatCount, formatList, plural } from "../../lib/format.ts";
import type { RowStatus } from "./work-model.ts";

/** Copy for the Task and Quest card, strip and drawer in the chat (STD-I18N-001). */
export const messages = {
  card: {
    quest: ({ name, count }: { name: string; count: number }) =>
      `${name}'s quest · ${plural(count, { one: "1 task", other: `${formatCount(count)} tasks` })}`,
    task: ({ name }: { name: string }) => `${name}'s task`,
    finished: ({ name }: { name: string }) => `${name} finished this`,
    failed: ({ name }: { name: string }) => `${name} could not finish this`,
    cancelled: ({ name }: { name: string }) => `${name} stopped this`,
    label: ({ name, title }: { name: string; title: string }) => `${name}'s work on ${title}`,
    progress: ({ done, total }: { done: number; total: number }) =>
      `${formatCount(done)} of ${formatCount(total)} done`,
    owner: ({ name }: { name: string }) => `· ${name}`,
    step: ({ index, total }: { index: number; total: number }) => `step ${formatCount(index)} of ${formatCount(total)}`,
    waitingOn: ({ names }: { names: string }) => `waiting on ${names}`,
    /** A Task whose turn waits on you to approve an action, named as the request names it (#698). */
    waitingApproval: ({ action }: { action: string }) => `waiting on your approval: ${action}`,
    /** Work about the request ran out of tries and waits for you in the Inbox (IN-007). */
    stuck: "Stuck",
    started: ({ ago }: { ago: string }) => `Started ${ago}`,
    openRoom: "Open room",
    open: ({ title }: { title: string }) => `Look inside ${title}`,
    workbench: "Open in Workbench",
  },
  status: {
    "needs-you": "Needs you",
    failed: "Failed",
    blocked: "Blocked",
    running: "Running",
    waiting: "Waiting",
    done: "Done",
  } satisfies Record<RowStatus, string>,
  strip: {
    label: "Work in progress",
    quest: ({ name }: { name: string }) => `${name}'s quest`,
    task: ({ name }: { name: string }) => `${name}'s task`,
    done: ({ done, total }: { done: number; total: number }) => `${formatCount(done)} of ${formatCount(total)} done`,
    needYou: ({ count }: { count: number }) =>
      plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
  },
  question: {
    asks: ({ name }: { name: string }) => `${name} asks you`,
    about: ({ title }: { title: string }) => `for ${title}`,
    answerLabel: ({ name }: { name: string }) => `Your answer to ${name}`,
    answerTo: ({ name }: { name: string }) => `Answer ${name}`,
    /** Where your answer goes, beside Send answer: as it travels, down the leads the question climbed. */
    goesStraight: ({ asker }: { asker: string }) => `Goes straight to ${asker}.`,
    goesThrough: ({ lead, asker }: { lead: string; asker: string }) => `Goes to ${lead}, who passes it to ${asker}.`,
    send: "Send answer",
    sending: "Sending…",
    youAnswered: ({ answer }: { answer: string }) => `You answered: ${answer}`,
    /** Your answer and where you gave it, seen from where it shows (#671): `here` when that is the same place. */
    youAnsweredIn: {
      here: ({ answer }: { answer: string }) => `You answered here: ${answer}`,
      chat: ({ answer }: { answer: string }) => `You answered in the chat: ${answer}`,
      inbox: ({ answer }: { answer: string }) => `You answered in the Inbox: ${answer}`,
      task: ({ answer }: { answer: string }) => `You answered in the Quest room: ${answer}`,
    },
    failed: "Your answer could not be sent. Try again.",
    closed: "This question was already answered.",
    withdrawn: "Withdrawn: the work it was about ended before anyone answered.",
    leadAnswered: ({ lead, asker }: { lead: string; asker: string }) => `${lead} answered ${asker} for you`,
  },
  drawer: {
    from: ({ name }: { name: string }) => `${name} gave it`,
    brief: "Brief",
    expected: ({ text }: { text: string }) => `Expected: ${text}`,
    folders: "Folders",
    noFolders: "No folders: it can only chat.",
    milestones: "Milestones",
    checkpoints: "Checkpoints",
    noCheckpoints: "Nothing reported yet.",
    questions: "Questions",
    approvals: "Waiting on your approval",
    output: "Output",
    given: "Handed to it",
    returned: ({ name, summary }: { name: string; summary: string }) => `${name}'s result: ${summary}`,
    noOutput: "No output yet.",
    tasks: "Tasks",
    reached: "Reached",
    notReached: "Not reached yet",
    answer: ({ name, answer }: { name: string; answer: string }) => `${name}: ${answer}`,
    withdrawn: "Withdrawn when this task ended.",
    notes: "Your notes",
    noteTo: ({ name, time }: { name: string; time: string }) => `To ${name} · ${time}`,
    asksYou: ({ name }: { name: string }) => `${name} asks you. Your answer goes straight back to ${name}.`,
    waitingOn: ({ name }: { name: string }) => `Waiting for ${name} to answer.`,
    waitsForYou: "Waiting for your answer, above.",
  },
  checkpoint: {
    milestone: "Milestone",
    finding: "Finding",
    blocker: "Blocker",
    question: "Question",
    progress: "Progress",
    started: "Started",
    waiting: "Waiting",
    done: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
    uncommitted: "Left uncommitted",
  } satisfies Record<CheckpointKind, string>,
  room: {
    you: "you",
    elsewhere: "Pinned from another thread",
    openThread: "Open its thread",
    missing: "A pinned quest is no longer on this hub.",
    unpin: "Unpin",
    unreadable: "A pinned quest could not be loaded right now.",
    tryAgain: "Try again",
    leads: "Leads a quest",
    /** A member that brought in hobs of its own: the party it leads under the Quest. */
    leadsParty: ({ names }: { names: string }) => `Leads ${names}`,
    /** Another Task of the work changed a file this one changed too (#570). */
    sameFile: ({ names }: { names: string }) => `Same file as ${names}`,
    /** A member that started a Quest of its own but has brought nobody into it (#576). */
    nobodyYet: "No one brought in yet",
    controls: ({ title }: { title: string }) => `Controls for ${title}`,
    retry: "Retry",
    reassign: "Reassign",
    cancelTask: "Cancel task",
    cancelling: "Cancelling…",
    retrying: "Retrying…",
    yesCancel: "Yes, cancel",
    giveTo: ({ title }: { title: string }) => `Give ${title} to`,
    giving: ({ name }: { name: string }) => `Giving it to ${name}…`,
    noOneElse: "No other hob can take this task.",
    keep: "Keep it",
    confirmTask: ({ title }: { title: string }) => `Cancel ${title} and everything under it?`,
    confirmQuest: "Cancel this quest? Every hob on it stops.",
    confirmRequest: "Cancel this task? Its hob stops.",
    /** A retry or reassignment the hub recorded, until its owner starts the new Attempt. */
    queued: ({ name, count }: { name: string; count: number }) =>
      `Queued: waiting for ${name} to start Attempt ${formatCount(count)}.`,
    /** A cancel asked for, while its Tasks confirm. */
    confirming: ({ confirmed, total }: { confirmed: number; total: number }) =>
      `Cancel asked for. ${formatCount(confirmed)} of ${formatCount(total)} ${plural(total, { one: "task", other: "tasks" })} confirmed stopped.`,
    /** A cancel every Task confirmed. */
    confirmedAll: ({ total }: { total: number }) =>
      plural(total, {
        one: "Cancelled: the task confirmed it stopped.",
        other: `Cancelled: ${formatCount(total)} tasks confirmed they stopped.`,
      }),
    /** A cancel that ended with some stops never confirmed (OR-006). */
    unresolved: ({ count }: { count: number }) =>
      plural(count, {
        one: "Cancelled, but 1 task never confirmed it stopped. Check what it did before you rely on it.",
        other: `Cancelled, but ${formatCount(count)} tasks never confirmed they stopped. Check what they did before you rely on them.`,
      }),
    refused: {
      "task-ended": "This work already ended, so there is nothing to cancel.",
      "task-state": "This task changed meanwhile. Look at where it stands and try again.",
      "task-cancelling": "This task is being cancelled.",
      "parent-cancelling": "The task above it is being cancelled.",
      "attempt-live": ({ name }: { name: string }) =>
        `${name} is working on it right now. Reassign it once that turn ends.`,
      "children-open": "Work is still open under this task. Cancel that first.",
      "quest-exists": "This task leads a quest of its own, so it stays with its hob.",
      "same-owner": ({ name }: { name: string }) => `${name} already has this task.`,
      "lineage-owner": ({ name }: { name: string }) => `${name} works on a task above this one, so it cannot take it.`,
      retired: ({ name }: { name: string }) => `${name} is retired, so it cannot take this work.`,
      gone: "That hob is no longer on this hub.",
      other: ({ message }: { message: string }) => `The hub refused this: ${message}`,
      failed: "This could not reach the hub. Try again.",
    },
    status: { cancelling: "Cancelling…", cancelled: "Cancelled", unresolved: "Not confirmed" },
  },
  someHob: "A hob",
  /** Names joined as a list in the reader's language: "Quill and Ada". */
  names: (names: ReadonlyArray<string>) => formatList(names),
};
