import type { WorkQuestState } from "@hobbots/domain";
import { formatTime, formatWeekdayDate } from "../../lib/format.ts";

/** A day the hob wrote as YYYY-MM-DD, as a date in the reader's own time zone. */
const localDay = (day: string): Date => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, date ?? 1);
};

/** Copy for a Quest's card in the chat (ADR 041, STD-I18N-001). */
export const messages = {
  eyebrow: {
    active: "Quest · Running",
    waiting: "Quest · Waiting on you",
    done: "Quest · Ready for review",
    stopped: "Quest · Stopped",
  } satisfies Record<WorkQuestState, string>,
  /** The card's name for a screen reader. */
  label: ({ title }: { title: string }) => `Quest: ${title}`,
  owner: ({ hob }: { hob: string }) => `${hob} runs it`,
  doneWhen: "Done when",
  result: "Result",
  made: "Made",
  started: ({ time }: { time: string }) => `Started ${formatTime(time)}`,
  expectedBy: ({ day }: { day: string }) => `Expected by ${formatWeekdayDate(localDay(day), false)}`,
  /** The one line the conversation gets when a hob finishes a Quest: "Aldric finished Winter market page". */
  finished: ({ hob, title }: { hob: string; title: string }) => `${hob} finished ${title}`,
  /** Between the parts of a line, as "Winter market page · PR #12". */
  dot: " · ",
  /** When the chat's Quests could not be read: the transcript still shows, without their cards. */
  unread: "Couldn't load this chat's Quests, so their cards are missing.",
  retry: "Try again",
};
