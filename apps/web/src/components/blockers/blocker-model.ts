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
  const tries = copy.why["retries-exhausted"]({ count: blocker.afterDeliveries - previousDeliveries(item, blocker) });
  return blocker.lastEnd === null ? tries : `${tries} ${copy.lastEnd[blocker.lastEnd]}`;
};

/** The deliveries the item had used before this blocker's round of tries. */
const previousDeliveries = (item: BackpackItem, blocker: BackpackBlocker) =>
  item.blockers.find((each) => each.number === blocker.number - 1)?.afterDeliveries ?? 0;

/** The open blockers among `items` about a Task in `taskIds`: the ones a Task card shows. */
export const blockersOn = (
  items: ReadonlyArray<BackpackItem>,
  taskIds: ReadonlySet<string>,
): ReadonlyArray<BackpackItem> =>
  items.filter((item) => openBlocker(item) !== undefined && item.taskId !== null && taskIds.has(item.taskId));
