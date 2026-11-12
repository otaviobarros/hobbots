import type { MemoryOverview } from "@hobbots/api";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { memoryOverviewQuery } from "../../api/memory.ts";
import { messages } from "./messages.ts";

/**
 * A card in Your data drawn from the memory overview: its title and tag, then still lines until the
 * hub answers, why it could not, or `children` with the overview.
 */
export function OverviewCard({
  id,
  label,
  tag,
  intro,
  children,
}: {
  id: string;
  label: string;
  tag: (overview: MemoryOverview) => ReactNode;
  intro?: string;
  children: (overview: MemoryOverview) => ReactNode;
}) {
  const overview = useQuery(memoryOverviewQuery);
  const data = overview.data;
  return (
    <section id={id} aria-label={label} className="flex scroll-mt-4 flex-col gap-3.5 rounded-card bg-card p-4">
      <span className="flex items-center gap-2.5">
        <strong className="flex-1 text-text-strong">{label}</strong>
        {data && tag(data)}
      </span>
      {intro !== undefined && <span className="text-ui text-text-secondary">{intro}</span>}
      {overview.isError && !data ? (
        <p role="alert" className="m-0 text-ui text-rose">
          {messages.card.failed}
        </p>
      ) : data === undefined ? (
        <span aria-busy className="flex flex-col gap-2">
          <Skeleton surface="card" width="48ch" className="max-w-full" />
          <Skeleton surface="card" width="32ch" className="max-w-full" />
        </span>
      ) : (
        children(data)
      )}
    </section>
  );
}
