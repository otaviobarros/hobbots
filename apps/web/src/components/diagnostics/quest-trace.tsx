import type { QuestTrace, TraceEntry } from "@hobbots/api";
import { RUNTIME_NAMES } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { firstLine } from "../../lib/format.ts";
import { formatTime, formatWhen } from "../../lib/time.ts";
import { messages } from "./messages.ts";
import { eventLabel, type HobName, type TraceRow, traceRows, triesText } from "./model.ts";

const copy = messages.follow;

const badgeFor = (state: TraceRow["task"]["state"]) => {
  switch (state) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "cancelling":
      return "cancelled";
    case "queued":
      return "queued";
    case "active":
      return "working";
    default:
      return "waiting";
  }
};

/** The IDs that follow a Task, as you would quote them in a bug report. */
function Ids({ row }: { row: TraceRow }) {
  const ids = [
    copy.taskId({ id: row.task.id }),
    ...(row.delegation ? [copy.delegationId({ id: row.delegation.id })] : []),
  ];
  return <span className="font-mono text-xs break-all text-label">{copy.idsLine({ ids: ids.join(" · ") })}</span>;
}

function TaskRow({ row, hobName }: { row: TraceRow; hobName: HobName }) {
  const { task, delegation } = row;
  return (
    <li
      className="flex flex-col gap-1 border-b-2 border-line py-2"
      style={{ paddingInlineStart: `${row.depth * 20}px` }}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 font-semibold">
          {hobName(task.ownerId)} · {row.title}
        </span>
        <Badge variant={badgeFor(task.state)}>{messages.taskStates[task.state]}</Badge>
      </span>
      {delegation && (
        <span className="text-sm text-text-secondary">
          {copy.delegated({ lead: hobName(delegation.leadId), member: hobName(delegation.memberId) })}
        </span>
      )}
      {row.attempts.length === 0 && <span className="text-sm text-text-secondary">{copy.noAttempts}</span>}
      {row.attempts.map((attempt) => (
        <span key={attempt.id} className="flex flex-col text-sm">
          <span>
            {copy.attempt({
              number: attempt.number,
              state: messages.attemptStates[attempt.state],
              runtime: RUNTIME_NAMES[attempt.runtime],
            })}
            {attempt.outcome !== null && <span className="text-text-secondary"> · {attempt.outcome}</span>}
          </span>
          <span className="font-mono text-xs break-all text-label">
            {copy.attemptId({ id: attempt.id })}
            {attempt.sessionId !== null && ` · ${copy.session({ id: attempt.sessionId })}`}
          </span>
        </span>
      ))}
      {row.items.map((item) => (
        <span key={item.id} className="text-sm text-lantern">
          {copy.waiting({
            hob: hobName(item.recipientId),
            kind: messages.itemKinds[item.kind],
            state: messages.itemStates[item.state],
            tries: triesText(item.deliveries.length),
          })}
        </span>
      ))}
      <Ids row={row} />
    </li>
  );
}

function EventRow({ entry, hobName }: { entry: TraceEntry; hobName: HobName }) {
  return (
    <li className="flex items-center gap-3 border-b-2 border-line py-1.5 text-sm">
      <time dateTime={entry.occurredAt} className="w-[72px] shrink-0 font-mono text-xs text-label">
        {formatTime(entry.occurredAt)}
      </time>
      <span className="min-w-0 flex-1">{eventLabel(entry.type)}</span>
      <span className="text-text-secondary">{entry.agentId === null ? "" : hobName(entry.agentId)}</span>
      <span className="font-mono text-xs text-label">{copy.sequence({ n: entry.sequence })}</span>
    </li>
  );
}

/** One Quest followed: its Tasks across hobs with their Delegations, tries and backpack items, then its events. */
export function QuestTraceView({ trace, hobName }: { trace: QuestTrace; hobName: HobName }) {
  const title = firstLine(trace.quest.goal);
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-sm">
        <span className="flex-1 text-text-secondary">
          {hobName(trace.quest.leadId)} · {formatWhen(trace.quest.createdAt)}
        </span>
        <Badge variant={trace.quest.state === "active" ? "working" : "muted"}>
          {messages.questStates[trace.quest.state]}
        </Badge>
      </span>
      <ul aria-label={copy.tasks({ title })} className="cut m-0 flex list-none flex-col bg-card px-3 py-1">
        {traceRows(trace).map((row) => (
          <TaskRow key={row.task.id} row={row} hobName={hobName} />
        ))}
      </ul>
      <span className="lbl pt-1 text-xs text-label">{copy.events}</span>
      <ol aria-label={copy.events} className="m-0 flex list-none flex-col p-0">
        {trace.journal.length === 0 && <li className="text-sm text-text-secondary">{copy.noEvents}</li>}
        {trace.journal.map((entry) => (
          <EventRow key={entry.sequence} entry={entry} hobName={hobName} />
        ))}
      </ol>
    </div>
  );
}
