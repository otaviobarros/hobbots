import type { MemoryCheck } from "@hobbots/api";
import { type MemoryChange, type MemoryShare, memoryScopeKey, memoryShareWaits } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
import { memoryKeys } from "./memory-pages.ts";
import { followsEvents } from "./queries.ts";

/**
 * What hobs ask to share, and Check now (ADR 028, Sharing). A share that waits for you shows in the
 * Inbox and in Memory › To review; the hub journals every change, so the list follows the event
 * stream. What Check now found waits only in To review.
 */

const sharesKey = ["memory-shares"] as const;
const checkKey = ["memory-check"] as const;

/** The shares that wait for you, oldest first, then the latest decided ones, newest first. */
export const memorySharesQuery = queryOptions({
  queryKey: sharesKey,
  queryFn: () => call((c) => c.memoryShares.list()),
  select: (answer) => answer.shares,
  ...followsEvents,
});

/** What the last Check now found. */
export const memoryCheckQuery = queryOptions({
  queryKey: checkKey,
  queryFn: () => call((c) => c.memoryShares.lastCheck()),
});

const NONE: ReadonlyArray<MemoryShare> = [];

/** The shares that wait for you now, kept live by the journal; none until read. */
export const waitingShares = (shares: ReadonlyArray<MemoryShare>): ReadonlyArray<MemoryShare> =>
  shares.filter(memoryShareWaits);

export const useWaitingShares = (): ReadonlyArray<MemoryShare> =>
  useQuery({ ...memorySharesQuery, select: (answer) => waitingShares(answer.shares) }).data ?? NONE;

/** A share was asked for or moved: the list is read again, and so is memory, which a share may have changed. */
export const memorySharesChanged = async (queryClient: QueryClient) => {
  await queryClient.invalidateQueries({ queryKey: sharesKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: memoryKeys.all });
};

/** Whether `error` says the share was decided elsewhere, or changed under it. */
export const shareClosed = (error: unknown): boolean =>
  error instanceof ApiError && (error.tag === "MemoryShareClosed" || error.tag === "MemoryShareNotFound");
export const shareChangedMeanwhile = (error: unknown): boolean =>
  error instanceof ApiError && error.tag === "MemoryShareChangedMeanwhile";

export type ShareDecision =
  | { readonly _tag: "share"; readonly markdown?: string }
  | { readonly _tag: "keep" }
  | { readonly _tag: "undo" };

/** Share it (as written or edited), Keep it private, or Undo. Settled either way, the list is read again. */
export const useDecideShare = (share: MemoryShare) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: ShareDecision): Promise<MemoryShare> => {
      const params = { shareId: share.id };
      switch (decision._tag) {
        case "share":
          return call((c) =>
            c.memoryShares.share({
              params,
              payload: decision.markdown === undefined ? {} : { markdown: decision.markdown },
            }),
          );
        case "keep":
          return call((c) => c.memoryShares.keep({ params }));
        case "undo":
          return call((c) => c.memoryShares.undo({ params }));
      }
    },
    onSettled: () => memorySharesChanged(queryClient),
  });
};

/** Check now: every scope, for pages that disagree or look out of date. */
export const useCheckNow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<MemoryCheck> => call((c) => c.memoryShares.check()),
    onSuccess: (checked) => queryClient.setQueryData(checkKey, checked),
  });
};

/** The share a saved version came from, when a share wrote it: what What changed offers Undo for. */
export const shareOfChange = (
  shares: ReadonlyArray<MemoryShare>,
  change: Pick<MemoryChange, "scope" | "path" | "version">,
): MemoryShare | undefined =>
  shares.find(
    (share) =>
      share.version === change.version &&
      share.path === change.path &&
      memoryScopeKey(share.scope) === memoryScopeKey(change.scope),
  );
