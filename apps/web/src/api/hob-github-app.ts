import type { HobGitHubAppLink } from "@hobbots/api";
import type { AgentId } from "@hobbots/domain";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

/**
 * A hob's own GitHub App (ADR 022), as its Charms tab shows it. The user makes it and installs it on
 * GitHub, so both are read again whenever the window comes back, and every few seconds while
 * `watching`, after the user went to GitHub.
 */
const hobGitHubAppKey = (agentId: AgentId) => ["charms", "hob-github-app", agentId] as const;

/** How long, and how often, the hob's app is read again after the user goes to GitHub. */
export const HOB_APP_WATCH = { forMs: 5 * 60_000, everyMs: 2_000 } as const;

export const hobGitHubAppQuery = (agentId: AgentId, watching = false) =>
  queryOptions({
    queryKey: hobGitHubAppKey(agentId),
    queryFn: () => call((c) => c.hobGitHubApp.status({ params: { agentId } })),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: watching ? HOB_APP_WATCH.everyMs : false,
    // The user is on GitHub, so Hobbots is not focused, though it may be beside the browser.
    refetchIntervalInBackground: watching,
  });

/**
 * Where the hob's app is installed. Reading it can change whether the app needs reconnecting: a key
 * GitHub refuses, or an app no longer installed anywhere, is marked as the list is read. So each read
 * reads the app's status again (only the status, or the two would read each other forever).
 */
export const useHobGitHubAppInstallations = (agentId: AgentId, appId: number, watching = false) => {
  const queryClient = useQueryClient();
  const refreshStatus = () => queryClient.invalidateQueries({ queryKey: hobGitHubAppKey(agentId), exact: true });
  return useQuery({
    queryKey: [...hobGitHubAppKey(agentId), "installations", appId],
    queryFn: () =>
      call((c) => c.hobGitHubApp.installations({ params: { agentId } })).finally(() => void refreshStatus()),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: watching ? HOB_APP_WATCH.everyMs : false,
    refetchIntervalInBackground: watching,
  });
};

/** Opens the hub page that takes the user to GitHub to make the hob's app. */
export const useStartHobGitHubApp = (agentId: AgentId) =>
  useMutation({ mutationFn: () => call((c) => c.hobGitHubApp.start({ params: { agentId } })) });

/** Links an app the user already has to the hob (#1321), then reads its status again. */
export const useLinkHobGitHubApp = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (link: HobGitHubAppLink) => call((c) => c.hobGitHubApp.link({ params: { agentId }, payload: link })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hobGitHubAppKey(agentId) }),
  });
};

/** Removes the hob's app from the hub, or dismisses an old one left over; then reads its status again. */
export const useDisconnectHobGitHubApp = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call((c) => c.hobGitHubApp.disconnect({ params: { agentId } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: hobGitHubAppKey(agentId) }),
  });
};
