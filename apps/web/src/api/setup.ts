import type { UpdateSetupPayload } from "@hobbots/api";
import type { InstallationSetup } from "@hobbots/domain";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

export const setupQueryKey = ["setup"] as const;

export const setupQuery = queryOptions({
  queryKey: setupQueryKey,
  queryFn: () => call((c) => c.setup.get()),
  // Setup changes only through this client, which updates the cache itself.
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * Whether opening the app shows Welcome rather than Home. When the setup cannot be read, for
 * example while the server restarts, Home opens and shows that it is reconnecting.
 */
export const opensWelcome = (setup: InstallationSetup | undefined): boolean => setup !== undefined && !setup.completed;

export const useUpdateSetup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSetupPayload) => call((c) => c.setup.update({ payload })),
    onSuccess: (setup) => queryClient.setQueryData(setupQueryKey, setup),
  });
};
