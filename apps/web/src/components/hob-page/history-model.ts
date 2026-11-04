import { type Agent, type AgentId, type HistoryEvent, historyNeedsYou, type ThreadId } from "@hobbots/domain";
import { firstLine, formatList } from "../../lib/format.ts";
import { localDay } from "../../lib/usage.ts";
import { messages } from "./messages.ts";

const copy = messages.history;

/** The mark beside an event: what it was, in a glyph and a color family that both read alone. */
export type HistoryMark = "done" | "fail" | "ask" | "quest" | "you" | "quiet";

/** Where an event's Chat or Workbench opens. */
export interface HistoryPlace {
  readonly hobId: AgentId;
  readonly threadId: ThreadId;
}

export interface HistoryRow {
  readonly id: string;
  readonly at: string;
  readonly mark: HistoryMark;
  readonly glyph: string;
  readonly line: string;
  /** Who did it, when it was not this hob: you, or a hob on its Quest. */
  readonly who: { readonly name: string; readonly hob: Agent | null } | null;
  readonly quest: string | null;
  readonly waiting: boolean;
  /** The Inbox entry Review opens, while the event still waits for you. */
  readonly review: string | null;
  readonly bench: (HistoryPlace & { readonly taskId: string; readonly attemptId: string | null }) | null;
  readonly chat: HistoryPlace | null;
}

const MARKS: Record<HistoryMark, string> = { done: "✓", fail: "✗", ask: "!", quest: "◆", you: "✓", quiet: "·" };

/** One event of a hob's History as its row: the mark, the line, who did it, and where it opens. */
export const historyRow = (event: HistoryEvent, hob: Agent, hobs: ReadonlyMap<AgentId, Agent>): HistoryRow => {
  const nameOf = (id: AgentId) => hobs.get(id)?.name ?? copy.someone;
  const other = event.agentId === hob.id ? null : { name: nameOf(event.agentId), hob: hobs.get(event.agentId) ?? null };
  const you = { name: copy.you, hob: null };
  const chat = event.threadId === null ? null : { hobId: event.agentId, threadId: event.threadId };
  const bench =
    chat === null || event.taskId === null ? null : { ...chat, taskId: event.taskId, attemptId: event.attemptId };
  const row = (
    mark: HistoryMark,
    line: string,
    extra: Partial<Pick<HistoryRow, "who" | "glyph" | "review" | "bench">> = {},
  ): HistoryRow => ({
    id: event.id,
    at: event.at,
    mark,
    glyph: MARKS[mark],
    line,
    who: other,
    quest: event.quest?.goal ?? null,
    waiting: historyNeedsYou(event),
    review: null,
    bench: null,
    chat,
    ...extra,
  });

  switch (event._tag) {
    case "TaskAsked":
      return row("you", copy.asked({ brief: firstLine(event.brief) }), { who: you, glyph: "→" });
    case "TaskPickedUp":
      return row("quest", copy.pickedUp({ brief: firstLine(event.brief), lead: nameOf(event.leadId) }));
    case "TaskEnded":
      if (event.state === "completed")
        return row(
          "done",
          event.summary === null ? copy.finished({ brief: firstLine(event.brief) }) : firstLine(event.summary),
          {
            bench: event.attempts > 0 ? bench : null,
          },
        );
      return row(
        event.state === "failed" ? "fail" : "quiet",
        event.state === "failed"
          ? copy.stopped({ brief: firstLine(event.brief), tries: event.attempts })
          : copy.cancelled({ brief: firstLine(event.brief) }),
        { bench: event.attempts > 0 ? bench : null },
      );
    case "QuestStarted": {
      const party = event.party.filter((id) => id !== event.agentId).map(nameOf);
      return row(
        "quest",
        copy.questStarted({ goal: event.quest?.goal ?? "", party: party.length > 0 ? formatList(party) : null }),
      );
    }
    case "QuestEnded":
      return event.state === "completed"
        ? row("quest", copy.questDone({ goal: event.quest?.goal ?? "" }), { glyph: "★" })
        : row("quiet", copy.questEnded({ goal: event.quest?.goal ?? "" }));
    case "Approval":
      switch (event.state) {
        case "pending":
          return row("ask", copy.approval.asks({ label: event.label }), { review: event.approvalId, bench });
        case "approved":
          return row("you", copy.approval.allowed({ label: event.label, always: event.lifetime === "always" }), {
            who: you,
          });
        case "denied":
          return row("you", copy.approval.denied({ label: event.label }), { who: you, glyph: "✕" });
        case "expired":
          return row("quiet", copy.approval.expired({ label: event.label }));
      }
      break;
    case "Question":
      return event.answer === null
        ? row("ask", copy.question.asks({ text: firstLine(event.text) }), { review: `question:${event.questionId}` })
        : row("you", copy.question.answered({ answer: firstLine(event.answer) }), { who: you });
  }
};

export interface HistoryDayGroup {
  readonly day: string;
  readonly label: string;
  readonly rows: ReadonlyArray<HistoryRow>;
}

/** A day's heading: Today, Yesterday, or the weekday and date where you are. */
export const dayLabel = (day: string, now: Date = new Date(), locale?: string): string => {
  if (day === localDay(now)) return copy.today;
  if (day === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return copy.yesterday;
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const at = new Date(year, month - 1, date);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(year === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
};
