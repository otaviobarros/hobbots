import type { BackpackItem, TaskId, TaskState, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useBlockers } from "../../api/blockers.ts";
import { formatAgo } from "../../lib/format.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import { blockersOn } from "../blockers/blocker-model.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { WorkbenchTab } from "../workbench/workbench-model.ts";
import { FlagIcon } from "./flag-icon.tsx";
import { messages } from "./messages.ts";
import { StatusTag } from "./status-dot.tsx";
import { StatusStrip } from "./status-strip.tsx";
import type { HobLookup } from "./use-work.ts";
import { taskTitle, type WorkCard, type WorkRow, workCard } from "./work-model.ts";

const copy = messages.card;

/** How the request ended, said of its lead, once it has. */
const ENDED: Partial<Record<TaskState, (name: { name: string }) => string>> = {
  completed: copy.finished,
  failed: copy.failed,
  cancelled: copy.cancelled,
};

/** Who leads the work and how big it is, or how it ended: a Quest counts its Tasks. */
const eyebrow = (card: WorkCard, name: string) =>
  ENDED[card.top.state]?.({ name }) ??
  (card.quest === null ? copy.task({ name }) : copy.quest({ name, count: card.progress.total }));

/**
 * The compact card under the request that started a Task: the Task card, and the Quest card once a
 * party joins (ADR 018). Who leads it, a strip with one segment per Task, every Task as a row by what
 * needs you first, and Open room, which opens the Quest room beside the chat (ADR 027). It wears no ring: only the Needs-you tray asks for you.
 */
export function QuestCard({
  tree,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  hobs: HobLookup;
  /** Opens the Quest room on a Task, its lane lit, with the Workbench open on a tab if one is named. */
  onOpen: (taskId: TaskId, options?: { readonly tab?: WorkbenchTab }) => void;
}) {
  const card = workCard(tree);
  const stuck = useStuck(tree);
  if (card === null) return null;
  const lead = hobs(card.leadId);
  const title = taskTitle(card.top);
  const { done, total } = card.progress;
  return (
    <section
      aria-label={copy.label({ name: lead.name, title })}
      className="ms-10 flex max-w-work-max animate-hb-in flex-col overflow-hidden rounded-card border-(length:--edge) border-line bg-card"
    >
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-2.5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-control bg-[color-mix(in_srgb,var(--color-star)_18%,transparent)] text-star"
        >
          <FlagIcon size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-meta font-semibold text-label">{eyebrow(card, lead.name)}</span>
          <span className="truncate font-heading text-title font-(--heading-weight) text-text-strong">{title}</span>
        </span>
        {stuck.length > 0 && <StatusTag status="blocked">{copy.stuck}</StatusTag>}
        {total > 0 && (
          <span className="text-detail whitespace-nowrap text-text-secondary">{copy.progress({ done, total })}</span>
        )}
      </div>
      {card.rows.length > 0 && (
        <>
          <StatusStrip statuses={card.rows.map((row) => row.status)} className="px-4 pb-3" />
          <ul className="m-0 flex list-none flex-col p-0">
            {card.rows.map((row) => (
              <li key={row.task.id} className="border-t border-line">
                <Row row={row} hobs={hobs} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-[color-mix(in_srgb,var(--color-deep)_45%,transparent)] px-4 py-2.5">
        <Button variant="outline" size="sm" onClick={() => onOpen(card.top.id)}>
          {copy.openRoom}
          <span aria-hidden>→</span>
        </Button>
        <span className="text-detail text-label">{copy.started({ ago: formatAgo(card.top.createdAt) })}</span>
        <Button variant="text" size="xs" className="ms-auto" onClick={() => onOpen(card.top.id, { tab: "summary" })}>
          {copy.workbench}
        </Button>
      </div>
    </section>
  );
}

/** The work about this tree's Tasks that failed as a blocker and waits for you (IN-007). */
const useStuck = (tree: TaskTree): ReadonlyArray<BackpackItem> =>
  blockersOn(useBlockers(), new Set(tree.tasks.map((task) => task.id)));

/** What a row adds under its title: an approval, a wait, a step, or what its owner last reported. */
const rowDetail = (row: WorkRow, hobs: HobLookup): string | null =>
  row.approval !== null
    ? copy.waitingApproval({ action: operationLabel(row.approval.operation) })
    : row.waitsOn.length > 0
      ? copy.waitingOn({ names: messages.names(row.waitsOn.map((id) => hobs(id).name)) })
      : row.step !== null
        ? copy.step(row.step)
        : row.latest;

/** One Task or the current step: its owner's tile, its title and owner, and where it stands. */
function Row({ row, hobs, onOpen }: { row: WorkRow; hobs: HobLookup; onOpen: (taskId: TaskId) => void }) {
  const owner = hobs(row.task.ownerId);
  const title = taskTitle(row.task);
  const detail = rowDetail(row, hobs);
  return (
    <button
      type="button"
      onClick={() => onOpen(row.task.id)}
      aria-label={copy.open({ title })}
      className="grid w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 border-0 bg-transparent px-4 py-2 text-start text-ui text-text-strong hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
    >
      <HobTile hob={owner} tile="sm" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          {title} <span className="text-text-secondary">{copy.owner({ name: owner.name })}</span>
        </span>
        {detail !== null && (
          <span className={cn("truncate text-detail", row.approval === null ? "text-text-secondary" : "text-lantern")}>
            {detail}
          </span>
        )}
      </span>
      <StatusTag status={row.status}>{messages.status[row.status]}</StatusTag>
    </button>
  );
}
