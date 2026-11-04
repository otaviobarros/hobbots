import type { AgentId } from "@hobbots/domain";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { useHobLookup } from "../quest/use-work.ts";
import { needLine } from "./hob-page-model.ts";

/** What the hob waits on you for, in one line, or undefined when it waits on nothing. */
export const useNeedLine = (hobId: AgentId): string | undefined => {
  const need = useWaitingHobs().get(hobId);
  const hobs = useHobLookup();
  return need && needLine(need, hobId, (id) => hobs(id).name);
};
