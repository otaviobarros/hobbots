import { type Agent, type AgentId, type HistoryEvent, historyNeedsYou, type ThreadId } from "@hobbots/domain";
import { firstLine, formatList } from "../../lib/format.ts";
import { localDay } from "../../lib/usage.ts";
import { messages } from "./messages.ts";

const copy = messages.history;

/** The mark beside an event: what it was, in a glyph and a color family that both read alone. */
export type HistoryMark = "done" | "fail" | "ask" | "quest" | "you" | "quiet";

/** Where an event's Chat or Workbench opens. */
interface HistoryPlace {
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

type Extra = Partial<Pick<HistoryRow, "who" | "glyph" | "review" | "bench">>;
type Row = (mark: HistoryMark, line: string, extra?: Extra) => HistoryRow;
type Bench = HistoryRow["bench"];
type HistoryOf<Tag extends HistoryEvent["_tag"]> = Extract<HistoryEvent, { readonly _tag: Tag }>;

const YOU = { name: copy.you, hob: null };

/** A Task that ended: its result, or that it stopped or was cancelled, with its Workbench once it ran. */
const endedRow = (event: HistoryOf<"TaskEnded">, row: Row, bench: Bench): HistoryRow => {
  const ran = { bench: event.attempts > 0 ? bench : null };
  const brief = firstLine(event.brief);
  if (event.state === "completed")
    return row("done", event.summary === null ? copy.finished({ brief }) : firstLine(event.summary), ran);
  if (event.state === "failed") return row("fail", copy.stopped({ brief, tries: event.attempts }), ran);
  return row("quiet", copy.cancelled({ brief }), ran);
};

/** An approval: waiting with Review, decided by you, or gone unanswered. */
const approvalRow = (event: HistoryOf<"Approval">, row: Row, bench: Bench): HistoryRow => {
  switch (event.state) {
    case "pending":
      return row("ask", copy.approval.asks({ label: event.label }), { review: event.approvalId, bench });
    case "approved":
      return row("you", copy.approval.allowed({ label: event.label, always: event.lifetime === "always" }), {
        who: YOU,
      });
    case "denied":
      return row("you", copy.approval.denied({ label: event.label }), { who: YOU, glyph: "✕" });
    case "expired":
      return row("quiet", copy.approval.expired({ label: event.label }));
  }
};

/** A Quest the hob leads: started with its party, then finished or ended early. */
const questRow = (
  event: HistoryOf<"QuestStarted" | "QuestEnded">,
  row: Row,
  nameOf: (id: AgentId) => string,
): HistoryRow => {
  const goal = event.quest?.goal ?? "";
  if (event._tag === "QuestStarted") {
    const party = event.party.filter((id) => id !== event.agentId).map(nameOf);
    return row("quest", copy.questStarted({ goal, party: party.length > 0 ? formatList(party) : null }));
  }
  return event.state === "completed"
    ? row("quest", copy.questDone({ goal }), { glyph: "★" })
    : row("quiet", copy.questEnded({ goal }));
};

/** One event of a hob's History as its row: the mark, the line, who did it, and where it opens. */
export const historyRow = (event: HistoryEvent, hob: Agent, hobs: ReadonlyMap<AgentId, Agent>): HistoryRow => {
  const nameOf = (id: AgentId) => hobs.get(id)?.name ?? copy.someone;
  const chat = event.threadId === null ? null : { hobId: event.agentId, threadId: event.threadId };
  const bench = chat && event.taskId !== null ? { ...chat, taskId: event.taskId, attemptId: event.attemptId } : null;
  const row: Row = (mark, line, extra = {}) => ({
    id: event.id,
    at: event.at,
    mark,
    glyph: MARKS[mark],
    line,
    who: event.agentId === hob.id ? null : { name: nameOf(event.agentId), hob: hobs.get(event.agentId) ?? null },
    quest: event.quest?.goal ?? null,
    waiting: historyNeedsYou(event),
    review: null,
    bench: null,
    chat,
    ...extra,
  });

  switch (event._tag) {
    case "TaskAsked":
      return row("you", copy.asked({ brief: firstLine(event.brief) }), { who: YOU, glyph: "→" });
    case "TaskPickedUp":
      return row("quest", copy.pickedUp({ brief: firstLine(event.brief), lead: nameOf(event.leadId) }));
    case "TaskEnded":
      return endedRow(event, row, bench);
    case "QuestStarted":
    case "QuestEnded":
      return questRow(event, row, nameOf);
    case "Approval":
      return approvalRow(event, row, bench);
    case "Question":
      return event.answer === null
        ? row("ask", copy.question.asks({ text: firstLine(event.text) }), { review: `question:${event.questionId}` })
        : row("you", copy.question.answered({ answer: firstLine(event.answer) }), { who: YOU });
  }
};

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
