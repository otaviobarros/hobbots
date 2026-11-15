import type { Quest } from "@hobbots/domain";
import { queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

// What a Quest cost (#1449), as the hub sums it from the usage its party's replies and turns
// reported. The usage arrives as each turn ends, so the read is taken again every half minute while
// it shows, and at once when the Quest's own record changes.

/** The cost of `quest`, keyed by its revision so a change to the Quest reads it again. */
export const questCostQuery = (quest: Pick<Quest, "id" | "revision">) =>
  queryOptions({
    queryKey: ["quest-cost", quest.id, quest.revision] as const,
    queryFn: () => call((c) => c.usage.questCost({ params: { questId: quest.id } })),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
