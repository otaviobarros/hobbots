import type { TaskId, TaskTree } from "@hobbots/domain";
import { progressStrip } from "./control-room.ts";
import { FlagIcon } from "./flag-icon.tsx";
import { messages } from "./messages.ts";
import { StatusStrip } from "./status-strip.tsx";
import { taskTitle, workCard } from "./work-model.ts";

const copy = messages.strip;

/**
 * The quest buttons in the chat header (ADR 018): one per request whose work runs here, and one per
 * Quest pinned from anywhere, each with its name, one strip segment per Task, how many are done and
 * a chip when any need you. Each opens its quest sheet.
 */
export function QuestButtons({ trees, onOpen }: { trees: ReadonlyArray<TaskTree>; onOpen: (taskId: TaskId) => void }) {
  if (trees.length === 0) return null;
  return (
    <section aria-label={copy.label} className="flex shrink-0 items-center gap-1.5">
      {trees.map((tree) => (
        <QuestButton key={tree.tasks[0]?.id} tree={tree} onOpen={onOpen} />
      ))}
    </section>
  );
}

function QuestButton({ tree, onOpen }: { tree: TaskTree; onOpen: (taskId: TaskId) => void }) {
  const card = workCard(tree);
  if (card === null) return null;
  const { segments, needs } = progressStrip(tree);
  const { done, total } = card.progress;
  return (
    <button
      type="button"
      onClick={() => onOpen(card.top.id)}
      className="flex h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-dot border-(length:--edge) border-line bg-card ps-3 pe-1.5 text-detail text-text-strong hover:bg-hover"
    >
      <FlagIcon size={16} className="text-star" />
      {/* A narrow header keeps the strip and the chip, and says the rest to a screen reader only.
          not-sr-only lets text wrap again, so the title truncates on a span of its own (#874). */}
      <span className="sr-only min-w-0 font-bold @5xl/header:not-sr-only">
        <span className="block max-w-[220px] truncate">{taskTitle(card.top)}</span>
      </span>
      <StatusStrip statuses={segments} small className="shrink-0" />
      {total > 0 && (
        <span className="sr-only whitespace-nowrap text-text-secondary @4xl/header:not-sr-only">
          {copy.done({ done, total })}
        </span>
      )}
      {needs > 0 ? (
        <span className="rounded-dot bg-lantern px-2.5 py-0.5 font-bold whitespace-nowrap text-ground">
          {copy.needYou({ count: needs })}
        </span>
      ) : (
        <span aria-hidden className="w-0.5" />
      )}
    </button>
  );
}
