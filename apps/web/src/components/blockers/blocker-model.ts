import { type BackpackBlocker, type BackpackItem, openBlocker } from "@hobbots/domain";
import { firstLine } from "../../lib/format.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** What the stuck work was, in words: the kind of item and the Task it names. */
export const blockerWhat = (item: BackpackItem): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "task":
    case "result":
    case "failure":
      return copy.what[payload._tag]({ title: firstLine(payload.task.brief) });
    default:
      return copy.what[payload._tag];
  }
};

/** Why it is stuck, in words, with how its last try ended when the hub said. */
export const blockerWhy = (item: BackpackItem, blocker: BackpackBlocker, hobName: string): string => {
  if (blocker.reason === "recipient-retired") return copy.why["recipient-retired"]({ name: hobName });
  const tries = copy.why["retries-exhausted"]({ count: blockerTries(item, blocker) });
  return blocker.lastEnd === null ? tries : `${tries} ${copy.lastEnd[blocker.lastEnd]}`;
};

/** How many times the item was tried in the round that ended in this blocker. */
export const blockerTries = (item: BackpackItem, blocker: BackpackBlocker): number =>
  blocker.afterDeliveries - (item.blockers.find((each) => each.number === blocker.number - 1)?.afterDeliveries ?? 0);

/** The open blockers among `items` about a Task in `taskIds`: the ones a Task card shows. */
export const blockersOn = (
  items: ReadonlyArray<BackpackItem>,
  taskIds: ReadonlySet<string>,
): ReadonlyArray<BackpackItem> =>
  items.filter((item) => openBlocker(item) !== undefined && item.taskId !== null && taskIds.has(item.taskId));
