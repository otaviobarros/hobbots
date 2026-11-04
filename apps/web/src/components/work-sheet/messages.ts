import { formatCount, plural } from "../../lib/format.ts";

/** User-facing copy for the quest sheet and the task sheet over the chat (STD-I18N-001). */
export const messages = {
  close: "Close",
  questEyebrow: ({ name }: { name: string }) => `${name}'s quest`,
  taskEyebrow: ({ name }: { name: string }) => `${name}'s task`,
  questLabel: ({ title }: { title: string }) => `${title}, quest`,
  started: ({ when }: { when: string }) => `Started ${when}`,
  done: ({ done, total }: { done: number; total: number }) => `${formatCount(done)} of ${formatCount(total)} done`,
  needYou: ({ count }: { count: number }) =>
    plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
  leads: ({ name }: { name: string }) => `${name} leads`,
  waitingOnTasks: ({ count }: { count: number }) =>
    plural(count, { one: "waiting on 1 task", other: `waiting on ${formatCount(count)} tasks` }),
  tasks: "Tasks",
  doneFolded: ({ count }: { count: number }) =>
    plural(count, { one: "1 more done", other: `${formatCount(count)} more done` }),
  showDone: "Show them",
  cancelQuestNote: ({ name }: { name: string }) => `Cancels every task under it. ${name} keeps what is done.`,
  cancelTaskNote: ({ name }: { name: string }) => `Stops ${name}. Whatever is done stays.`,
  back: ({ title }: { title: string }) => `Back to ${title}`,
  meta: ({ name, attempt, age }: { name: string; attempt: number; age: string }) =>
    attempt === 0 ? `${name} · not started · ${age}` : `${name} · attempt ${formatCount(attempt)} · ${age}`,
  asksYouTag: "? Asks you",
  reviewInChat: "Review in chat",
  openWorkbench: "Open Workbench",
  details: "Everything in this task",
  question: {
    asks: ({ name }: { name: string }) => `${name} asks you`,
    passedUp: ({ chain, when }: { chain: ReadonlyArray<string>; when: string }) =>
      `Passed up by ${[...chain, "you"].join(" → ")} · asked ${when}`,
    goesTo: ({ name }: { name: string }) => `Your answer goes straight back to ${name}.`,
  },
  notFound: "This task is not in this thread.",
} as const;
