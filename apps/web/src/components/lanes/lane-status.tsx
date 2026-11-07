import { cn } from "@hobbots/ui/lib/utils";
import { formatAgo } from "../../lib/format.ts";
import { useNow } from "../inbox/use-now.ts";
import type { HobLookup } from "../quest/use-work.ts";
import type { LaneItem } from "./lane-model.ts";
import { messages } from "./messages.ts";

/** A decorative mark for a wait; its words are always beside it. */
const WAIT = "◷";

/** How long a running lane stays without a new step before it says when its last one was. */
const QUIET_AFTER_MS = 60_000;

/**
 * The turn that runs now: the step it is on, or the command it waits on. Once nothing new has been
 * recorded for a minute it also says when the last step was, so a hob that waits or is stuck reads
 * differently from one that just moved (#1004).
 */
function NowRow({ item }: { item: Extract<LaneItem, { kind: "now" }> }) {
  const now = useNow();
  const quiet = now.getTime() - new Date(item.since).getTime() >= QUIET_AFTER_MS;
  const label = item.label ?? messages.now;
  return (
    <li className="flex items-center gap-2 text-detail text-mint">
      <span aria-hidden className="size-2 shrink-0 animate-hb-blink rounded-dot bg-mint" />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      {quiet && (
        <span className="shrink-0 text-meta text-label">
          <span aria-hidden>· </span>
          {messages.quiet({ ago: formatAgo(item.since, now) })}
        </span>
      )}
    </li>
  );
}

/** The lines that say where the Task stands: a wait, a turn that runs now, or how it ended. */
export function LaneStatusRow({
  item,
  hobs,
}: {
  item: Extract<LaneItem, { kind: "wait" | "now" | "result" }>;
  hobs: HobLookup;
}) {
  switch (item.kind) {
    case "wait": {
      const who = item.on.map((each) => (each.kind === "you" ? messages.you : hobs(each.id).name));
      return (
        <li className="flex items-center gap-2 text-detail text-lantern">
          <span aria-hidden>{WAIT}</span>
          <span>{messages.waits({ names: messages.names(who) })}</span>
        </li>
      );
    }
    case "now":
      return <NowRow item={item} />;
    case "result":
      return (
        <li
          className={cn(
            // A result can quote a long folder path, which wraps rather than widening the lane.
            "rounded-control px-2 py-1.5 text-detail text-text wrap-anywhere",
            item.outcome === "completed"
              ? "bg-[color-mix(in_srgb,var(--color-mint)_12%,var(--color-card))]"
              : "bg-[color-mix(in_srgb,var(--color-rose)_12%,var(--color-card))]",
          )}
        >
          <b className={cn(item.outcome === "completed" ? "text-mint" : "text-rose")}>
            {messages.result[item.outcome]}
          </b>
          {item.text !== null && ` · ${item.text}`}
          {item.text === null && item.outcome === "failed" && ` · ${messages.stoppedWhy}`}
        </li>
      );
  }
}
