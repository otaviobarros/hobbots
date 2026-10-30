import type { UpdateSetupPayload } from "@hobbots/api";
import type { InstallationSetup } from "@hobbots/domain";
import { type QueryClient, queryOptions, useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

export const setupQueryKey = ["setup"] as const;

export const setupQuery = queryOptions({
  queryKey: setupQueryKey,
  queryFn: () => call((c) => c.setup.get()),
});

/**
 * The setup for screens that act on it while another window or device may change it, such as
 * finishing setup or connecting a provider: always fresh, checked again on focus and every few
 * seconds while the screen is open.
 */
export const watchedSetupQuery = queryOptions({
  ...setupQuery,
  staleTime: 0,
  refetchOnWindowFocus: true,
  refetchInterval: 3000,
});

/**
 * Whether opening the app shows Welcome rather than Home. When the setup cannot be read, for
 * example while the server restarts, Home opens and shows that it is reconnecting.
 */
/** Whether setup is done, so Welcome and the setup steps hand over to Home. Unknown counts as not done. */
export const setupDone = (setup: InstallationSetup | undefined): boolean => setup?.completed === true;

export const opensWelcome = (setup: InstallationSetup | undefined): boolean => setup !== undefined && !setup.completed;

/**
 * The setup as the hub stores it now. Another client may have finished setup since this one last
 * asked, so a cached answer is used only when the hub cannot be reached.
 */
export const readSetup = (queryClient: QueryClient, query: typeof setupQuery = setupQuery) =>
  queryClient
    .fetchQuery({ ...query, staleTime: 0 })
    .catch(() => queryClient.getQueryData<InstallationSetup>(query.queryKey));

const updateSetupKey = ["setup", "update"] as const;

/** Whether a setup change is still on its way to the hub, so a step can wait for it before moving on. */
export const useSavingSetup = () => useIsMutating({ mutationKey: updateSetupKey }) > 0;

export const useUpdateSetup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: updateSetupKey,
    mutationFn: (payload: UpdateSetupPayload) => call((c) => c.setup.update({ payload })),
    onSuccess: (setup) => queryClient.setQueryData(setupQueryKey, setup),
  });
};
