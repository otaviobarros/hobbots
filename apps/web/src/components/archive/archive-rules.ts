import type { ApprovalRequest, Message, Thread, ThreadId } from "@hobbots/domain";
import { isInProgress } from "@hobbots/domain";

/**
 * Why a thread cannot be archived now, as the hub decides it: `approval-pending` wins over
 * `reply-running` when both apply.
 */
export type ArchiveBlock = "reply-running" | "approval-pending";

/**
 * What this client knows that stops an archive: a pending approval, or a reply that runs or waits
 * in the queue. `live` is the thread's activity from live events, for a thread whose messages are
 * not loaded. The hub checks again and refuses when the client did not know.
 */
export const archiveBlock = ({
  messages,
  approvals,
  live,
}: {
  messages: ReadonlyArray<Message> | undefined;
  approvals: ReadonlyArray<ApprovalRequest> | undefined;
  live: boolean;
}): ArchiveBlock | null => {
  if (approvals?.some((approval) => approval.state === "pending")) return "approval-pending";
  const replying = messages?.some((message) => isInProgress(message.status) || message.status === "queued") ?? false;
  return replying || live ? "reply-running" : null;
};

/**
 * The thread to open after the open one is archived: the one below it, else the one above, else
 * none, which opens the fresh page.
 */
export const nextThread = (threads: ReadonlyArray<Thread>, archived: ThreadId): Thread | undefined => {
  const index = threads.findIndex((thread) => thread.id === archived);
  if (index === -1) return undefined;
  return threads[index + 1] ?? threads[index - 1];
};

interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** ⌃⌘A on a Mac, Ctrl+Alt+A elsewhere: archives the open thread. */
export const isArchiveKey = (event: KeyLike): boolean =>
  event.code === "KeyA" && event.ctrlKey && (event.metaKey || event.altKey) && !event.shiftKey;

/** ⌘Z on a Mac, Ctrl+Z elsewhere: undoes the last archive while its toast shows. */
export const isUndoKey = (event: KeyLike): boolean =>
  event.code === "KeyZ" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;

/** Whether the element takes text, so ⌘Z there undoes typing rather than an archive. */
export const isTextField = (element: Element | null): boolean => {
  if (element === null) return false;
  if ((element as { isContentEditable?: boolean }).isContentEditable === true) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (element as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(type);
};

/** Whether this is a Mac, whose shortcuts read ⌃⌘A and ⌘Z. */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "");
