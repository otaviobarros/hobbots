import { type BackpackItem, openBlocker } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { recordBackpackItem, syncedBlockers, withNewer } from "./sync.ts";

const blockersKey = ["blockers"] as const;

/**
 * The backpack items whose blocker waits for you (IN-007), oldest blocker first, kept live by the
 * journal: an item that changes while the list is read is reconciled with it (ADR 013).
 */
const blockersQuery = queryOptions({
  queryKey: blockersKey,
  queryFn: syncedBlockers(() => call((c) => c.blockers.list()).then((read) => read.items)),
  ...followsEvents,
});

/**
 * Keeps an item that changed in the blocker list: in it, at its newer version, while its blocker
 * waits for you, and out of it once it does not.
 */
export const storeBlocker = (queryClient: QueryClient, item: BackpackItem) => {
  recordBackpackItem(queryClient, item);
  queryClient.setQueryData<ReadonlyArray<BackpackItem>>(blockersKey, (old) => withBlocker(old, item));
};

/** A cached list with the item's newer version, kept only while its blocker is open. */
export const withBlocker = (
  old: ReadonlyArray<BackpackItem> | undefined,
  item: BackpackItem,
): ReadonlyArray<BackpackItem> | undefined => withNewer(old, item, (kept) => openBlocker(kept) !== undefined);

/**
 * Retry or Dismiss the blocker you saw, by its number, so the choice never reaches a newer one. A
 * refused choice, most likely made elsewhere first or overtaken by a newer blocker, reads the list again.
 */
export const useDecideBlocker = (item: BackpackItem) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choice: { readonly blocker: number; readonly action: "retry" | "dismiss" }) =>
      call((c) => c.blockers.decide({ params: { itemId: item.id }, payload: choice })),
    onSuccess: (decided) => storeBlocker(queryClient, decided),
    onError: () => queryClient.invalidateQueries({ queryKey: blockersKey, exact: true }),
  });
};

const NONE: ReadonlyArray<BackpackItem> = [];

/**
 * The read of the blockers, with its loading and failure states, for a view that must not say
 * nothing waits while it does not know (the Inbox's Needs you).
 */
export const useBlockersQuery = () => useQuery(blockersQuery);

/** The work that failed as a blocker and waits for the user's choice, oldest first; none until read. */
export const useBlockers = (): ReadonlyArray<BackpackItem> => useBlockersQuery().data ?? NONE;
