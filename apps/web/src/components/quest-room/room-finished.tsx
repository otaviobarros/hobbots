import type { TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { formatDuration } from "../../lib/format.ts";
import { progressStrip } from "../quest/control-room.ts";
import { workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.finished;

/** What a finished request's banner says: what was delivered, how much was done and how long it took. */
const finishedText = (tree: TaskTree): { readonly summary: string | null; readonly meta: string } | null => {
  const card = workCard(tree);
  if (card === null || card.top.state !== "completed") return null;
  const { top } = card;
  const took = formatDuration(card.took ?? 0);
  const { done, total } = card.progress;
  const parts = [
    ...(total > 0 ? [copy.tasks({ done, total })] : []),
    copy.took({ took }),
    ...(progressStrip(tree).needs === 0 ? [copy.nothingNeedsYou] : []),
  ];
  return { summary: top.result?.summary ?? null, meta: parts.join(" · ") };
};

/**
 * The banner under the room's header once the request it holds has finished (ADR 027): Quest
 * finished, the lead's summary of what was delivered, how many Tasks were done and how long it
 * took, with See what changed and Open the files.
 */
export function RoomFinished({
  tree,
  onChanges,
  onFiles,
}: {
  tree: TaskTree;
  onChanges: () => void;
  onFiles: () => void;
}) {
  const text = finishedText(tree);
  if (text === null) return null;
  const quest = workCard(tree)?.quest ?? null;
  const title = quest === null ? copy.taskTitle : copy.questTitle;
  return (
    <section
      aria-label={title}
      className="mx-5 mt-3.5 flex flex-wrap items-center gap-4 rounded-card border-(length:--edge) border-solid border-mint bg-[color-mix(in_srgb,var(--color-mint)_14%,var(--color-card))] px-4 py-3.5"
    >
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-dot bg-mint text-title font-bold text-ground"
      >
        ✓
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-heading text-title font-(--heading-weight) text-text-strong">{title}</span>
        {text.summary !== null && (
          <span className="line-clamp-3 text-ui text-text-strong wrap-anywhere" title={text.summary}>
            {text.summary}
          </span>
        )}
        <span className="text-detail text-text-secondary">{text.meta}</span>
      </span>
      <span className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onChanges}>
          {copy.changes}
        </Button>
        <Button variant="outline" size="sm" onClick={onFiles}>
          {copy.files}
        </Button>
      </span>
    </section>
  );
}
