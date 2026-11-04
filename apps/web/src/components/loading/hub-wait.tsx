import { Button } from "@hobbots/ui/components/button";
import { useWaitStage } from "@hobbots/ui/lib/wait-stage";
import { messages } from "./messages.ts";

const copy = messages;

/** A list from the hub holds three skeleton rows while it reads, in the list's own row shape. */
export const SKELETON_ROWS = [0, 1, 2] as const;

/** Likely lengths for the skeleton rows' lines, so the three rows don't read as one block. */
export const ROW_WIDTHS = ["26ch", "18ch", "22ch"] as const;

/**
 * The wait line of a region that reads from the hub. Hub reads are quick, so it shows nothing for
 * the first 10 seconds, only the region's skeletons. Then it says the hub is slow and offers Try
 * again, in case the hub is out of reach (the Skeleton and WaitNote rules in docs/design/ui-ux.md). The status stays mounted
 * while the region waits, so its line is announced once when it appears.
 */
export function HubWait({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
  const wait = useWaitStage(pending);
  if (!pending) return null;
  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-x-2 text-detail text-text-secondary empty:hidden"
    >
      {wait.stage === "stuck" && (
        <>
          <span>{copy.stuck}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              wait.restart();
              onRetry();
            }}
          >
            {copy.retry}
          </Button>
        </>
      )}
    </div>
  );
}
