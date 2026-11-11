import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memoryOverviewQuery } from "../../api/memory.ts";
import { messages } from "./messages.ts";
import { hubUsageLine, usageLine } from "./model.ts";

/**
 * Usage's Memory line (ADR 028): the memory model's calls and tokens since the memory engine last
 * started, or why it makes none, and the hub's brain's own turns (ADR 037), with a link to choose the model. A still line holds its place until the hub answers.
 */
export function MemoryUsage() {
  const overview = useQuery(memoryOverviewQuery);
  const line = usageLine(overview.data) ?? (overview.isError ? messages.usage.unknown : null);
  const hub = hubUsageLine(overview.data);
  if (line === null)
    return (
      <span aria-busy className="rounded-control bg-card px-3.5 py-2.5">
        <Skeleton surface="card" width="40ch" className="max-w-full" />
      </span>
    );
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-card px-3.5 py-2.5 text-ui">
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-text">{line}</span>
        {hub !== null && <span className="text-detail text-text-secondary">{hub}</span>}
      </span>
      <Link to="/settings/$section" params={{ section: "data" }} hash="brain" className="text-link underline">
        {messages.usage.open}
      </Link>
    </p>
  );
}
