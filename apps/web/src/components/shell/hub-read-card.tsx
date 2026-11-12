import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useHubReads } from "../../api/hub-reads.ts";
import { messages } from "../messages.ts";

const copy = messages.hubReads;

/**
 * Says, at the top of the page, that the hub's status or Quest summaries could not be read, so a
 * resting hob or an empty strip is not taken for the truth, and reads them again on Try again. While
 * the live stream is down the reconnecting card says so instead, and a reconnect reads them again.
 */
export function HubReadCard({ hidden, className }: { hidden: boolean; className?: string }) {
  const reads = useHubReads();
  if (hidden || reads.kind === "read") return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-none animate-hb-in items-center gap-3 rounded-card bg-notice py-2.5 ps-3.5 pe-3 text-ui text-text-strong",
        className,
      )}
    >
      <span className="flex-1">{copy.failed}</span>
      <Button variant="outline" size="xs" onClick={reads.retry} disabled={reads.retrying}>
        {reads.retrying ? copy.tryingAgain : copy.tryAgain}
      </Button>
    </div>
  );
}
