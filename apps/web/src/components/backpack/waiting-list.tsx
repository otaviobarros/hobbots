import type { BackpackItem } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { formatWhen } from "../../lib/time.ts";
import { BlockerChoices } from "../blockers/blocker-choices.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { StatusDot, StatusTag } from "../quest/status-dot.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { type WaitingView, waitingState, waitingTone, waitingWhat } from "./backpack-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * A view of what hobs are waiting on (ADR 019): each item with what it is, who owes a response and
 * since when, where it stands, and what you can do: open its Task, or Retry or Dismiss it once it
 * is stuck, as on its blocker card. Handled items stay a moment with how they were handled; routine progress is a count.
 * `owners` shows each item's hob, for a view of more than one hob.
 */
export function WaitingList({
  view,
  hobs,
  now,
  owners,
  limit = Number.POSITIVE_INFINITY,
  onOpen,
  label,
  className,
}: {
  view: WaitingView;
  hobs: HobLookup;
  now: Date;
  owners: boolean;
  /** At most this many rows; the rest fold into a count. */
  limit?: number;
  onOpen: (item: BackpackItem) => void;
  label: string;
  className?: string;
}) {
  const rows = [...view.open, ...view.handled];
  const shown = rows.slice(0, limit);
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <ul aria-label={label} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {shown.map((item) => (
          <li key={item.id}>
            <WaitingRow item={item} hobs={hobs} now={now} owners={owners} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <span className="px-2 text-xs text-label">{copy.more({ count: rows.length - shown.length })}</span>
      )}
      {view.routine > 0 && <span className="px-2 text-xs text-label">{copy.routine({ count: view.routine })}</span>}
    </div>
  );
}

function WaitingRow({
  item,
  hobs,
  now,
  owners,
  onOpen,
}: {
  item: BackpackItem;
  hobs: HobLookup;
  now: Date;
  owners: boolean;
  onOpen: (item: BackpackItem) => void;
}) {
  const state = waitingState(item);
  const tone = waitingTone(state);
  const owner = hobs(item.recipientId);
  const body = (
    <>
      <StatusDot status={tone} />
      {owners && <HobSprite hob={owner} size={18} />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-detail">{waitingWhat(item, (id) => hobs(id).name)}</span>
        <span className="truncate text-xs text-label">
          {owners && `${copy.awaiting({ name: owner.name })} · `}
          <time dateTime={item.createdAt}>{copy.since({ since: formatWhen(item.createdAt, now) })}</time>
        </span>
      </span>
      <span title={copy.stateHint[state]} className="flex">
        <StatusTag status={tone}>{copy.state[state]}</StatusTag>
        <span className="sr-only">{copy.stateHint[state]}</span>
      </span>
    </>
  );
  return (
    <div className={cn("flex flex-col", item.state === "resolved" && "opacity-70")}>
      {/* An item about a Task opens it; one about none, such as your note, is only shown. */}
      {item.taskId === null ? (
        <div className={ROW}>{body}</div>
      ) : (
        <button type="button" onClick={() => onOpen(item)} className={cn(ROW, "cursor-pointer hover:bg-hover")}>
          {body}
        </button>
      )}
      {state === "stuck" && (
        <div className="flex flex-col gap-1 ps-6 pe-2 pb-1.5">
          <BlockerChoices item={item} hob={owner} />
        </div>
      )}
    </div>
  );
}

const ROW = "flex w-full items-center gap-2 border-0 bg-transparent px-2 py-1.5 text-start text-text";
