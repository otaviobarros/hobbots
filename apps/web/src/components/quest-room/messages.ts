import { formatCount, plural } from "../../lib/format.ts";

/** Copy for the Quest room beside the chat (ADR 027, STD-I18N-001). */
export const messages = {
  room: "Quest room",
  label: ({ title }: { title: string }) => `${title}, Quest room`,
  close: "Close room",
  closeHint: "The chat takes the full width again",
  questEyebrow: ({ name }: { name: string }) => `${name}'s quest`,
  taskEyebrow: ({ name }: { name: string }) => `${name}'s task`,
  done: ({ done, total }: { done: number; total: number }) => `${formatCount(done)} of ${formatCount(total)} done`,
  needYou: ({ count }: { count: number }) =>
    plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
  party: "The party",
  goToLane: ({ name }: { name: string }) => `Go to ${name}'s lane`,
  menu: ({ title }: { title: string }) => `${title} menu`,
  pin: "Pin quest",
  unpin: "Unpin quest",
  cancelQuest: "Cancel quest…",
  cancelTask: "Cancel task…",
  notFound: "This work is not in this thread.",
  reading: "Opening the room…",
  readFailed: "The room could not be opened.",
  tryAgain: "Try again",
  lanes: "Lanes",
  lane: ({ name }: { name: string }) => `${name}'s lane`,
  pick: ({ name }: { name: string }) => `Show ${name}'s work in the Workbench`,
  lead: "Lead",
  showInWorkbench: "Show in the Workbench",
  details: "Everything in this task",
  ended: "The work has ended. The room stays as a recap.",
  chat: {
    fold: "Fold the chat",
    foldHint: "Fold the chat to give the lanes more room",
    open: "Open the chat",
    folded: "Chat, folded",
    unread: ({ name }: { name: string }) => `Open the chat, new from ${name}`,
    newFrom: ({ name }: { name: string }) => `New from ${name}`,
  },
  /** A Task's line in its lane: which try it is on and when it started. */
  taskMeta: ({ attempt, age }: { attempt: number; age: string }) =>
    attempt === 0 ? `not started · ${age}` : `attempt ${formatCount(attempt)} · ${age}`,
  /** What the lead's lane says beside its role while its Task waits on the party's work. */
  waitingOnTasks: ({ count }: { count: number }) =>
    plural(count, { one: "waiting on 1 task", other: `waiting on ${formatCount(count)} tasks` }),
  dock: {
    label: "Workbench",
    /** The dock's name, which says whose work it shows: "Workbench for Draft the landing copy". */
    named: ({ title }: { title: string }) => `Workbench for ${title}`,
    open: "Open the Workbench",
    fold: "Fold the Workbench",
  },
} as const;
