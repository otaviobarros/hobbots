import type { TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { StatusDot, StatusTag } from "./status-dot.tsx";
import type { HobLookup } from "./use-work.ts";
import { taskTitle, type WorkCard, type WorkRow, workCard } from "./work-model.ts";

const copy = messages.card;

const ring = (card: WorkCard) =>
  card.status === "needs-you"
    ? "border-lantern"
    : card.top.state === "completed"
      ? "border-mint-deep"
      : card.top.state === "failed"
        ? "border-rose"
        : "border-control";

const heading = (card: WorkCard, name: string) => {
  switch (card.top.state) {
    case "completed":
      return copy.finished({ name });
    case "failed":
      return copy.failed({ name });
    case "cancelled":
      return copy.cancelled({ name });
    default:
      return copy.onIt({ name });
  }
};

/**
 * The live card under the request that started a Task: the Task card, and the Quest card once a
 * party joins (ADR 018). At most four rows, by what needs you first; done rows fold into a count.
 */
export function QuestCard({
  tree,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const card = workCard(tree);
  if (card === null) return null;
  const lead = hobs(card.leadId);
  const title = taskTitle(card.top);
  const members = card.party.map((id) => hobs(id).name);
  const { done, total } = card.progress;
  return (
    <section
      aria-label={copy.label({ name: lead.name, title })}
      className={cn(
        "cut ms-9 flex max-w-work-max animate-hb-in flex-col gap-2.5 border-2 bg-card px-3.5 py-3",
        ring(card),
      )}
    >
      <div className="flex items-center gap-2">
        <HobSprite hob={lead} size={20} state={card.status === "running" ? "working" : "idle"} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-pixel text-base font-semibold">{heading(card, lead.name)}</span>
          <span className="truncate text-detail text-secondary-text">{title}</span>
        </span>
        {total > 0 && (
          <span className="text-detail whitespace-nowrap text-label">{copy.progress({ done, total })}</span>
        )}
      </div>
      {total > 0 && <Progress done={done} total={total} />}
      {members.length > 0 && (
        <p className="m-0 flex items-center gap-1.5 text-detail text-secondary-text">
          {card.party.map((id) => (
            <HobSprite key={id} hob={hobs(id)} size={18} />
          ))}
          <span>{copy.party({ lead: lead.name, members: messages.names(members) })}</span>
        </p>
      )}
      {card.rows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {card.rows.map((row) => (
            <li key={row.task.id}>
              <Row row={row} hobs={hobs} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {/* Always there, so a Task without rows still opens its brief and output once it ends. */}
      <div className="flex items-center gap-2 text-detail text-label">
        {card.more > 0 && <span>{copy.moreCount({ count: card.more })}</span>}
        {card.done > 0 && <span>{copy.doneCount({ count: card.done })}</span>}
        <Button variant="link" size="xs" className="ms-auto" onClick={() => onOpen(card.top.id)}>
          {card.rows.length + card.done + card.more > 0 ? copy.showAll : copy.details}
        </Button>
      </div>
    </section>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div aria-hidden className="h-meter bg-deep">
      <div className="h-full bg-mint" style={{ width: `${Math.round((done / total) * 100)}%` }} />
    </div>
  );
}

/** One Task or the current step, with its owner, where it stands and what it waits on. */
function Row({ row, hobs, onOpen }: { row: WorkRow; hobs: HobLookup; onOpen: (taskId: TaskId) => void }) {
  const owner = hobs(row.task.ownerId);
  const title = taskTitle(row.task);
  const detail =
    row.waitsOn.length > 0
      ? copy.waitingOn({ names: messages.names(row.waitsOn.map((id) => hobs(id).name)) })
      : row.step !== null
        ? copy.step(row.step)
        : row.latest;
  return (
    <button
      type="button"
      onClick={() => onOpen(row.task.id)}
      aria-label={copy.open({ title })}
      className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-panel px-2.5 py-2 text-start text-text hover:bg-hover"
    >
      <StatusDot status={row.status} />
      <HobSprite hob={owner} size={18} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-bold">{title}</span>
        <span className="truncate text-detail text-secondary-text">
          {detail === null ? owner.name : copy.rowDetail({ name: owner.name, detail })}
        </span>
      </span>
      <StatusTag status={row.status}>{messages.status[row.status]}</StatusTag>
    </button>
  );
}
