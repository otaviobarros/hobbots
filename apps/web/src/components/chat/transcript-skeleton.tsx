import { Skeleton } from "@hobbots/ui/components/skeleton";
import { HubWait } from "../loading/hub-wait.tsx";

/** The lines of each reply block, as likely lengths, so the two blocks read as two replies. */
const REPLIES = [
  ["100%", "100%", "62%"],
  ["100%", "84%"],
] as const;

/**
 * The transcript while it is read: two reply blocks at the column's measure, each a tile, a name
 * and a few lines in skeleton, where the replies land. The composer below is ready at once.
 */
export function TranscriptSkeleton({ onRetry }: { onRetry: () => void }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3.5">
      {REPLIES.map((lines, reply) => (
        <div key={lines.length} aria-hidden className="flex flex-col gap-2.5">
          <span className="flex items-center gap-2.5 text-ui">
            <Skeleton shape="tile" className="size-7.5" />
            <Skeleton width={reply === 0 ? "6ch" : "8ch"} />
          </span>
          <span className="ms-10 flex min-w-0 flex-col">
            {lines.map((width, line) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed and never reorder.
              <Skeleton key={line} width={width} />
            ))}
          </span>
        </div>
      ))}
      <HubWait pending onRetry={onRetry} />
    </div>
  );
}
