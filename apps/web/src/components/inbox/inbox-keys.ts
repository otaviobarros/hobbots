import type { Quest, TaskId } from "@hobbots/domain";
import { isPageKey, type KeyPress } from "../../lib/page-keys.ts";
import { byUrgency, groupByPlace, type InboxEntry } from "./inbox-entries.ts";
import type { InboxView } from "./inbox-items.ts";

/** Which way a key moves through the list in Needs you. */
export type InboxStep = "previous" | "next";

const STEPS: Readonly<Record<string, InboxStep>> = {
  ArrowUp: "previous",
  k: "previous",
  K: "previous",
  ArrowDown: "next",
  j: "next",
  J: "next",
};

/** The step a press means, ↑ or K up and ↓ or J down, or `undefined` when it is not one or belongs elsewhere. */
export const stepKey = (press: KeyPress): InboxStep | undefined => {
  const step = STEPS[press.key];
  return step !== undefined && isPageKey(press) ? step : undefined;
};

/** The entries in the order the list shows them: by quest, group after group, or by urgency. */
export const shownOrder = (
  entries: ReadonlyArray<InboxEntry>,
  view: InboxView,
  questOf: (taskId: TaskId) => Quest | undefined,
): ReadonlyArray<InboxEntry> =>
  view === "urgency" ? [...entries].sort(byUrgency) : groupByPlace(entries, questOf).flatMap((group) => group.entries);

/**
 * The entry one step up or down from the selected one, held at the ends of the list. With none
 * selected, it is the first.
 */
export const stepFrom = (
  order: ReadonlyArray<InboxEntry>,
  selectedKey: string | undefined,
  step: InboxStep,
): InboxEntry | undefined => {
  const index = order.findIndex((entry) => entry.key === selectedKey);
  if (index === -1) return order[0];
  return order[Math.min(order.length - 1, Math.max(0, index + (step === "next" ? 1 : -1)))];
};
