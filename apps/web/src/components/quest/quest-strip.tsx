import type { TaskId, TaskTree } from "@hobbots/domain";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { StatusDot } from "./status-dot.tsx";
import type { HobLookup } from "./use-work.ts";
import { liveTrees, type RowStatus, workCard, workCounts } from "./work-model.ts";

const copy = messages.strip;

const SHOWN: ReadonlyArray<RowStatus> = ["needs-you", "failed", "blocked", "running", "waiting", "done"];

/**
 * Keeps the work in view under the chat header once its card scrolls away: portraits and counts,
 * never rows (ADR 018). It leaves once every request's work has ended.
 */
export function QuestStrip({
  trees,
  hobs,
  onOpen,
}: {
  trees: ReadonlyArray<TaskTree>;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const live = liveTrees(trees);
  if (live.length === 0) return null;
  return (
    <section
      aria-label={copy.label}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b-2 border-line bg-panel px-4 py-2"
    >
      {live.map((tree) => (
        <StripItem key={tree.tasks[0]?.id} tree={tree} hobs={hobs} onOpen={onOpen} />
      ))}
    </section>
  );
}

function StripItem({ tree, hobs, onOpen }: { tree: TaskTree; hobs: HobLookup; onOpen: (taskId: TaskId) => void }) {
  const card = workCard(tree);
  if (card === null) return null;
  const lead = hobs(card.leadId);
  const counts = workCounts(tree);
  const shown = SHOWN.filter((status) => counts[status] > 0);
  return (
    <button
      type="button"
      onClick={() => onOpen(card.top.id)}
      aria-label={copy.open({ name: lead.name })}
      className="cut flex min-w-0 cursor-pointer items-center gap-2 border-2 border-line-2 bg-panel px-2.5 py-1 text-detail text-text hover:bg-hover"
    >
      <HobSprite hob={lead} size={20} state={counts["needs-you"] > 0 ? "needs-you" : "working"} />
      <span className="whitespace-nowrap text-secondary-text">
        {card.quest === null ? copy.task({ name: lead.name }) : copy.quest({ name: lead.name })}
      </span>
      {card.party.map((id) => (
        <HobSprite key={id} hob={hobs(id)} size={16} />
      ))}
      {shown.map((status) => (
        <span key={status} className="flex items-center gap-1.5 whitespace-nowrap">
          <StatusDot status={status} />
          {copy.count({ status, count: counts[status] })}
        </span>
      ))}
    </button>
  );
}
