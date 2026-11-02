import type { BackpackItem } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { handledLongAgo } from "../components/backpack/backpack-model.ts";
import { storeBlocker } from "./blockers.ts";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncedBackpack, withNewer } from "./sync.ts";

const backpackKey = ["backpack"] as const;

/**
 * What every hob is waiting on (ADR 019): the workspace's open backpack items, kept live by the
 * journal. The hob panel and the Quest tab each take their own view of this one list, so an item
 * that changes moves in every view at once.
 */
const backpackQuery = queryOptions({
  queryKey: backpackKey,
  queryFn: syncedBackpack(() => call((c) => c.backpack.workspace()).then((read) => read.items)),
  ...followsEvents,
});

/**
 * Keeps an item that changed where it shows: in the waiting list at its newer version, resolved
 * ones too, so they can say how they were handled, and in the blocker list while it is stuck.
 */
export const storeBackpackItem = (queryClient: QueryClient, item: BackpackItem) => {
  storeBlocker(queryClient, item);
  const now = new Date();
  queryClient.setQueryData<ReadonlyArray<BackpackItem>>(backpackKey, (old) =>
    // Items handled long ago leave as others arrive, so a long session does not keep every one.
    withNewer(
      old?.filter((each) => !handledLongAgo(each, now)),
      item,
      (kept) => kept.state !== "failed",
    ),
  );
};

const NONE: ReadonlyArray<BackpackItem> = [];

/**
 * Every hob's items that have not failed, open ones and ones resolved since the list was read
 * (none until read), with the read's state, so a view never says nothing waits while it does not
 * know, and `retry` to read again after a failure.
 */
export const useBackpack = () => {
  const query = useQuery(backpackQuery);
  return {
    items: query.data ?? NONE,
    status: query.status,
    retry: () => void query.refetch(),
  };
};
