import { type AgentId, type BackpackItem, isActionableKind, openBlocker } from "@hobbots/domain";
import { firstLine } from "../../lib/format.ts";
import { type RowStatus, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * Where an item stands for you (IN-002): waiting for a turn, delivered into one, acknowledged by
 * the runtime, being read, handled in one of four ways, or stuck as a blocker.
 */
export type WaitingState =
  | "waiting"
  | "delivered"
  | "acknowledged"
  | "processing"
  | "consumed"
  | "answered"
  | "late"
  | "dismissed"
  | "stuck";

export const waitingState = (item: BackpackItem): WaitingState => {
  switch (item.state) {
    case "pending":
      return "waiting";
    case "failed":
      return "stuck";
    case "resolved":
      return item.disposition?._tag ?? "consumed";
    default:
      return item.state;
  }
};

/** The status tone a state shows in, shared with the Task rows beside it. */
export const waitingTone = (state: WaitingState): RowStatus => {
  switch (state) {
    case "stuck":
      return "failed";
    case "processing":
      return "running";
    case "consumed":
    case "answered":
      return "done";
    default:
      return "waiting";
  }
};

/** Which hobs' items a view shows: one hob's, those about a request's Tasks and Quests, or every hob's. */
export type WaitingScope =
  | { readonly kind: "hob"; readonly hobId: AgentId }
  | { readonly kind: "tree"; readonly taskIds: ReadonlySet<string>; readonly questIds: ReadonlySet<string> }
  | { readonly kind: "workspace" };

const inScope = (item: BackpackItem, scope: WaitingScope): boolean => {
  switch (scope.kind) {
    case "hob":
      return item.recipientId === scope.hobId;
    case "tree":
      return item.taskId === null
        ? item.questId !== null && scope.questIds.has(item.questId)
        : scope.taskIds.has(item.taskId);
    case "workspace":
      return true;
  }
};

/** How long a handled item stays in view after it was handled, so you see it leave. */
export const HANDLED_FOR_MS = 60_000;

export interface WaitingView {
  /** Stuck items first, oldest blocker first; then open actionable items, most urgent and oldest first. */
  readonly open: ReadonlyArray<BackpackItem>;
  /** Items handled within the last minute, most recent first. */
  readonly handled: ReadonlyArray<BackpackItem>;
  /** Open routine progress, which wakes nobody and rides along the next turn (IN-005). */
  readonly routine: number;
}

const byUrgency = (a: BackpackItem, b: BackpackItem) =>
  b.priority - a.priority || a.createdAt.localeCompare(b.createdAt);

/**
 * One view of what hobs are waiting on, from the waiting list and the blocker list: the items in
 * `scope` that still need their hob, and the ones handled a moment ago.
 */
export const waitingView = (
  items: ReadonlyArray<BackpackItem>,
  blockers: ReadonlyArray<BackpackItem>,
  scope: WaitingScope,
  now: Date,
): WaitingView => {
  const mine = items.filter((item) => inScope(item, scope));
  const unsettled = mine.filter((item) => item.state !== "resolved");
  const stuck = blockers.filter((item) => openBlocker(item) !== undefined && inScope(item, scope));
  return {
    open: [...stuck, ...unsettled.filter((item) => isActionableKind(item.kind)).sort(byUrgency)],
    handled: mine
      .filter((item) => item.state === "resolved" && isActionableKind(item.kind) && !handledLongAgo(item, now))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    routine: unsettled.filter((item) => !isActionableKind(item.kind)).length,
  };
};

/** Whether a resolved item was handled long enough ago to leave every view. */
export const handledLongAgo = (item: BackpackItem, now: Date): boolean =>
  item.state === "resolved" && now.getTime() - new Date(item.updatedAt).getTime() >= HANDLED_FOR_MS;

/** How many items in a view need their hob: what its count says. */
export const waitingCount = (view: WaitingView): number => view.open.length;

/** What an item is, in words, naming who sent it where the item says. */
export const waitingWhat = (item: BackpackItem, nameOf: (id: AgentId) => string): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "task":
      return copy.what.task({ title: taskTitle(payload.task) });
    case "result":
    case "failure":
      return copy.what[payload._tag]({ name: nameOf(payload.task.ownerId), title: taskTitle(payload.task) });
    case "checkpoint":
    case "progress":
      return copy.what.checkpoint({ summary: firstLine(payload.checkpoint.summary) });
    case "question":
      return copy.what.question({ name: nameOf(payload.question.askerId), text: firstLine(payload.question.text) });
    case "answer":
      return copy.what.answer({ text: firstLine(payload.question.answer ?? "") });
    case "hand-off":
      return copy.what["hand-off"]({ label: payload.artifact.label });
    case "message":
      return payload.senderId === null
        ? copy.what.note({ text: firstLine(payload.text) })
        : copy.what.message({ name: nameOf(payload.senderId), text: firstLine(payload.text) });
    default:
      return copy.what[payload._tag];
  }
};
