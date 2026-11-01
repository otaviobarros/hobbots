import type { CheckpointKind } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import type { RowStatus } from "./work-model.ts";

/** Copy for the Task and Quest card, strip and drawer in the chat (STD-I18N-001). */
export const messages = {
  card: {
    onIt: ({ name }: { name: string }) => `${name} is on it`,
    finished: ({ name }: { name: string }) => `${name} finished this`,
    failed: ({ name }: { name: string }) => `${name} could not finish this`,
    cancelled: ({ name }: { name: string }) => `${name} stopped this`,
    party: ({ lead, members }: { lead: string; members: string }) => `${lead}'s party: ${members}`,
    label: ({ name, title }: { name: string; title: string }) => `${name}'s work on ${title}`,
    progress: ({ done, total }: { done: number; total: number }) =>
      `${formatCount(done)} of ${formatCount(total)} done`,
    step: ({ index, total }: { index: number; total: number }) => `step ${formatCount(index)} of ${formatCount(total)}`,
    waitingOn: ({ names }: { names: string }) => `waiting on ${names}`,
    doneCount: ({ count }: { count: number }) => plural(count, { one: "1 done", other: `${formatCount(count)} done` }),
    moreCount: ({ count }: { count: number }) => plural(count, { one: "1 more", other: `${formatCount(count)} more` }),
    rowDetail: ({ name, detail }: { name: string; detail: string }) => `${name} · ${detail}`,
    showAll: "Show all",
    details: "Show details",
    open: ({ title }: { title: string }) => `Look inside ${title}`,
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
    open: ({ name }: { name: string }) => `Show ${name}'s work`,
    count: ({ status, count }: { status: RowStatus; count: number }) => {
      const n = formatCount(count);
      switch (status) {
        case "needs-you":
          return plural(count, { one: "1 needs you", other: `${n} need you` });
        case "failed":
          return `${n} failed`;
        case "blocked":
          return `${n} blocked`;
        case "running":
          return `${n} running`;
        case "waiting":
          return `${n} waiting`;
        case "done":
          return `${n} done`;
      }
    },
  },
  question: {
    asks: ({ name }: { name: string }) => `${name} asks you`,
    about: ({ title }: { title: string }) => `for ${title}`,
    answerLabel: ({ name }: { name: string }) => `Your answer to ${name}`,
    answerPlaceholder: "Type your answer",
    send: "Send answer",
    sending: "Sending…",
    youAnswered: ({ answer }: { answer: string }) => `You answered: ${answer}`,
    failed: "Your answer could not be sent. Try again.",
    closed: "This question was already answered.",
    leadAnswered: ({ lead, asker }: { lead: string; asker: string }) => `${lead} answered ${asker} for you`,
  },
  drawer: {
    label: ({ title }: { title: string }) => `${title}, Task details`,
    close: "Close",
    back: ({ title }: { title: string }) => `Back to ${title}`,
    from: ({ name }: { name: string }) => `${name} gave it`,
    brief: "Brief",
    expected: ({ text }: { text: string }) => `Expected: ${text}`,
    milestones: "Milestones",
    checkpoints: "Checkpoints",
    noCheckpoints: "Nothing reported yet.",
    questions: "Questions",
    output: "Output",
    given: "Handed to it",
    noOutput: "No output yet.",
    tasks: "Tasks",
    reached: "Reached",
    notReached: "Not reached yet",
    answer: ({ name, answer }: { name: string; answer: string }) => `${name}: ${answer}`,
    you: "You",
    notFound: "This Task is not in this thread.",
    noteLabel: ({ name }: { name: string }) => `Tell ${name} about this task`,
    noteHint: ({ name }: { name: string }) => `You talk to ${name}, who passes it on.`,
    send: "Send",
    sent: ({ name }: { name: string }) => `Sent to ${name}.`,
    noteFailed: "Your note could not be sent. Try again.",
    /** The message the note becomes in the lead's chat. */
    note: ({ title, note }: { title: string; note: string }) => `About “${title}”: ${note}`,
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
  } satisfies Record<CheckpointKind, string>,
  room: {
    label: ({ title }: { title: string }) => `Control room for ${title}`,
    emptyTitle: "No Quest in this thread",
    empty:
      "When a hob splits work or asks other hobs for help, the Quest shows up here: who is on each Task, what they wait on, and how far it got. Pin a Quest to keep it in view while you chat elsewhere.",
    summary: ({ whose, done, total }: { whose: string; done: number; total: number }) =>
      `${whose} · ${formatCount(done)} of ${formatCount(total)} done`,
    elsewhere: "Pinned from another thread",
    openThread: "Open its thread",
    pin: "Pin",
    pinned: "Pinned",
    missing: "A pinned Quest is no longer on this hub.",
    unpin: "Unpin",
    unreadable: "A pinned Quest could not be loaded right now.",
    tryAgain: "Try again",
    pinHint: "Pin: keep this Quest in view in every thread",
    unpinHint: "Unpin: show it only in its own thread",
    tree: ({ title }: { title: string }) => `Tasks of ${title}`,
    row: ({ name, title }: { name: string; title: string }) => `${name} · ${title}`,
    you: "you",
    leads: "Leads a quest",
    pick: "Pick a Task to retry, reassign or cancel it.",
    controls: ({ title }: { title: string }) => `Controls for ${title}`,
    attempt: ({ count }: { count: number }) => `Attempt ${formatCount(count)}`,
    notStarted: "Not started yet",
    retry: "Retry",
    reassign: "Reassign",
    cancelTask: "Cancel Task",
    cancelQuest: "Cancel Quest",
    cancelling: "Cancelling…",
    /** Why the controls cannot be used yet: the hub does not confirm their outcome so far (OR-006). */
    held: "Retry, Reassign and Cancel arrive once the hub can confirm what each one did.",
    status: { cancelling: "Cancelling…", cancelled: "Cancelled" },
  },
  someHob: "A hob",
  /** Names joined as a list in the reader's language: "Quill and Ada". */
  names: (names: ReadonlyArray<string>) => new Intl.ListFormat(undefined, { type: "conjunction" }).format(names),
};
