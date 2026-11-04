import type { Agent } from "@hobbots/domain";
import { useBackpack } from "../../api/backpack.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useNow } from "../inbox/use-now.ts";
import { useHobLookup } from "../quest/use-work.ts";
import { waitingCount, waitingView } from "./backpack-model.ts";
import { useOpenItem } from "./use-open-item.ts";

/** What waits in one hob's backpack, with what a `WaitingList` of it needs: the hobs it names and how an item opens. */
export const useHobWaiting = (hob: Pick<Agent, "id">) => {
  const now = useNow();
  const view = waitingView(useBackpack().items, useBlockers(), { kind: "hob", hobId: hob.id }, now);
  return { now, view, hobs: useHobLookup(), openItem: useOpenItem(), count: waitingCount(view) };
};
