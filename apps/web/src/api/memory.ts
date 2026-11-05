import type { MemoryOverview } from "@hobbots/api";
import type { MemorySettings } from "@hobbots/domain";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

const memoryKey = ["memory"] as const;

/**
 * Settings › Your data › Memory (ADR 028): the engine's state, what it keeps and the memory model.
 * Checked again every so often while it shows, since the engine restarts on its own.
 */
export const memoryOverviewQuery = queryOptions({
  queryKey: [...memoryKey, "overview"] as const,
  queryFn: () => call((c) => c.memory.overview()),
  refetchInterval: 15_000,
});

/** Stores the memory model; the hub restarts only the memory engine's process to apply it. */
export const useUpdateMemorySettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...memoryKey, "settings"],
    mutationFn: (payload: MemorySettings) => call((c) => c.memory.settings({ payload })),
    onSuccess: (overview: MemoryOverview) => queryClient.setQueryData(memoryOverviewQuery.queryKey, overview),
  });
};
