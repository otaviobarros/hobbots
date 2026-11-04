import type { WaitingQuestion } from "@hobbots/api";
import { type ApprovalRequest, type BackpackItem, openBlocker, type ThreadId } from "@hobbots/domain";
import { approvalEntry, entryThread, type InboxEntry, questionEntry, stuckEntry } from "../inbox/inbox-entries.ts";

/** One thing the tray asks about: a request to approve, work that is stuck, or a question for you. */
export type TrayEntry = Exclude<InboxEntry, { kind: "device" } | { kind: "failed" }>;

/**
 * What the tray holds, in the order it asks: pending approvals, then stuck work, then questions,
 * each oldest first. With `threadId`, only what is about that thread.
 */
export const trayEntries = ({
  requests,
  blockers,
  questions,
  threadId,
}: {
  readonly requests: ReadonlyArray<ApprovalRequest>;
  readonly blockers: ReadonlyArray<BackpackItem>;
  readonly questions: ReadonlyArray<WaitingQuestion>;
  readonly threadId?: ThreadId | undefined;
}): ReadonlyArray<TrayEntry> => {
  const entries = [
    ...requests.filter((request) => request.state === "pending").map(approvalEntry),
    ...blockers.filter((item) => openBlocker(item) !== undefined).map(stuckEntry),
    ...questions.filter(({ question }) => question.state === "open").map(questionEntry),
  ].filter((entry): entry is TrayEntry => entry.kind !== "device");
  return threadId === undefined ? entries : entries.filter((entry) => entryThread(entry) === threadId);
};

/**
 * The entry the tray shows: the one it showed before while that one still waits, else the one now
 * at the same place, else the last. Undefined when nothing waits.
 */
export const shownEntry = (
  entries: ReadonlyArray<TrayEntry>,
  key: string | undefined,
  index: number,
): { readonly entry: TrayEntry; readonly index: number } | undefined => {
  if (entries.length === 0) return undefined;
  const kept = entries.findIndex((entry) => entry.key === key);
  const at = kept >= 0 ? kept : Math.min(index, entries.length - 1);
  return { entry: entries[at] as TrayEntry, index: at };
};
