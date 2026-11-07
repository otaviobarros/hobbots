import { type BackpackItem, openBlocker, type Task } from "@hobbots/domain";
import { DropdownMenuItem } from "@hobbots/ui/components/menu";
import { useBlockers, useDecideBlocker } from "../../api/blockers.ts";
import { blockerChoice } from "../blockers/blocker-choices.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { messages } from "./messages.ts";

/**
 * The stuck work about a lane's Task that Retry can send again: its hob ran out of tries and has
 * not retired. The lane's menu offers Retry on it as its card does, so the two agree (#1087).
 */
export const useStuckRetry = (task: Task, hobs: HobLookup): BackpackItem | undefined => {
  const stuck = useBlockers().find((item) => item.taskId === task.id && openBlocker(item) !== undefined);
  return stuck !== undefined && blockerChoice(stuck, hobs(task.ownerId))?.retired === false ? stuck : undefined;
};

/** Retry on stuck work about the lane's Task: a fresh set of tries, as Retry on its card sends. */
export function StuckRetryItem({ item }: { item: BackpackItem }) {
  const decide = useDecideBlocker(item);
  const blocker = openBlocker(item);
  if (blocker === undefined) return null;
  return (
    <DropdownMenuItem
      disabled={decide.isPending}
      onSelect={() => decide.mutateAsync({ blocker: blocker.number, action: "retry" }).catch(() => undefined)}
    >
      {messages.retry}
    </DropdownMenuItem>
  );
}
