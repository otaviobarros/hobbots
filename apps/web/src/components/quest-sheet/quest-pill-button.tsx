import type { ThreadId } from "@hobbots/domain";
import { useThreadSummaries } from "../../api/quest-summaries.ts";
import { FlagIcon } from "../quest/flag-icon.tsx";
import { messages } from "./messages.ts";
import { questPill } from "./quest-pill.ts";

const copy = messages.pill;

/**
 * A camp's quest pill in its header (ADR 037): "2 quests · 1 ready for review · 1 needs you", as the
 * hub's quest summaries say, opening the camp's sheet where each quest is listed. Hidden while no
 * quest of the camp is under way.
 */
export function QuestPillButton({ threadId, open, onOpen }: { threadId: ThreadId; open: boolean; onOpen: () => void }) {
  const pill = questPill(threadId, useThreadSummaries(threadId));
  if (pill === null) return null;
  const parts = [
    copy.quests({ count: pill.quests }),
    ...(pill.review > 0 ? [copy.review({ count: pill.review })] : []),
    ...(pill.needs > 0 ? [copy.needYou({ count: pill.needs })] : []),
  ];
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={copy.named({ parts })}
      title={copy.open}
      onClick={onOpen}
      className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-dot border-(length:--edge) border-line bg-card ps-3 pe-1.5 text-detail text-text-strong hover:bg-hover"
    >
      <FlagIcon size={16} className="text-star" />
      <span className="font-semibold whitespace-nowrap">{copy.quests({ count: pill.quests })}</span>
      {pill.review > 0 && (
        <span className="sr-only whitespace-nowrap text-text-secondary @4xl/header:not-sr-only">
          {copy.review({ count: pill.review })}
        </span>
      )}
      {pill.needs > 0 ? (
        <span className="rounded-dot bg-lantern px-2.5 py-0.5 font-bold whitespace-nowrap text-ground">
          {copy.needYou({ count: pill.needs })}
        </span>
      ) : (
        <span aria-hidden className="w-0.5" />
      )}
    </button>
  );
}
