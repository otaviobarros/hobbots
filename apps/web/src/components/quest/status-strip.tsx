import { cn } from "@hobbots/ui/lib/utils";
import type { RowStatus } from "./work-model.ts";

const fill: Record<RowStatus, string> = {
  "needs-you": "bg-lantern",
  failed: "bg-rose",
  blocked: "bg-rose",
  running: "bg-star",
  waiting: "bg-line-2",
  done: "bg-mint",
};

/**
 * One segment per Task, colored by where it stands: done mint, needs you lantern, stuck rose,
 * working star, the rest line-2. Decorative: the words beside it say the same. `small` draws the
 * 14 by 4 segments of the chat header's Quest button; otherwise the segments share the width.
 */
export function StatusStrip({
  statuses,
  small = false,
  className,
}: {
  statuses: ReadonlyArray<RowStatus>;
  small?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("flex gap-0.5", className)}>
      {statuses.map((status, index) => (
        <span
          // The segments only ever change color in place.
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its position.
          key={index}
          className={cn("rounded-dot", small ? "h-1 w-3.5" : "h-1.5 flex-1", fill[status])}
        />
      ))}
    </span>
  );
}
