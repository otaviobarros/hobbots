import type { AgentId, HobWebLimits, ThreadId, WebLimits, WebSettings, WebUsageSummary } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

/**
 * Searching and reading the web (ADR 036): what a chat's replies searched and read, Settings › Web,
 * a hob's own limits, Usage's searches and pages, and the hub's page cache.
 */

const webKey = ["web"] as const;

const webKeys = {
  thread: (threadId: ThreadId) => [...webKey, "thread", threadId] as const,
  settings: [...webKey, "settings"] as const,
  hobLimits: (agentId: AgentId) => [...webKey, "hob-limits", agentId] as const,
  summary: (since: string) => [...webKey, "summary", since] as const,
  cache: [...webKey, "cache"] as const,
};

/** The most records a chat's read lists; a chat that read more shows its newest. */
const THREAD_RECORDS = 200;

/** What a chat's replies searched and read, newest first. The stream reads it again as each is recorded. */
export const threadWebQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: webKeys.thread(threadId),
    queryFn: () => call((c) => c.web.usage({ query: { threadId, limit: THREAD_RECORDS } })),
  });

/** Settings › Web: the limits every hob has and the sites hobs never read. */
export const webSettingsQuery = queryOptions({
  queryKey: webKeys.settings,
  queryFn: () => call((c) => c.web.settings()),
});

/** A hob's own limits and the ones that hold for it. */
export const hobWebLimitsQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: webKeys.hobLimits(agentId),
    queryFn: () => call((c) => c.web.hobLimits({ params: { agentId } })),
  });

/** What every hob searched and read since `since`, for Usage. */
export const webSummaryQuery = (since: string) =>
  queryOptions({
    queryKey: webKeys.summary(since),
    queryFn: (): Promise<WebUsageSummary> => call((c) => c.web.usageSummary({ query: { since } })),
  });

/** The pages the hub holds for 15 minutes. */
export const pageCacheQuery = queryOptions({
  queryKey: webKeys.cache,
  queryFn: () => call((c) => c.web.pageCache()),
});

/**
 * A search or a page was recorded, or Settings › Web or a hob's limits changed, here or elsewhere:
 * what shows them is read again. A read already on its way may predate the change, so it is cancelled first.
 */
export const webChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: webKey });
  await queryClient.invalidateQueries({ queryKey: webKey });
};

/** Saves Settings › Web; a blocked site that names no host is refused with why. */
export const useSetWebSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: { readonly limits: WebLimits; readonly blockedSites: ReadonlyArray<string> }) =>
      call((c) => c.web.setSettings({ payload: settings })),
    onSuccess: (saved: WebSettings) => {
      queryClient.setQueryData(webKeys.settings, saved);
      return webChanged(queryClient);
    },
  });
};

/** Sets a hob's own limits; a null limit follows Settings › Web. */
export const useSetHobWebLimits = (agentId: AgentId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (limits: HobWebLimits) => call((c) => c.web.setHobLimits({ params: { agentId }, payload: limits })),
    onSuccess: (view) => {
      queryClient.setQueryData(webKeys.hobLimits(agentId), view);
      return webChanged(queryClient);
    },
  });
};

/** Clears the hub's page cache, so the next read of every page goes to its site. */
export const useClearPageCache = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call((c) => c.web.clearPageCache()),
    onSuccess: (held) => queryClient.setQueryData(webKeys.cache, held),
  });
};
