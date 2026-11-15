import type { ApprovalRequest, Channel, ChannelId, Message } from "@hobbots/domain";
import { isInProgress } from "@hobbots/domain";

/**
 * Why a channel cannot be archived now, as the hub decides it: `approval-pending` wins over
 * `reply-running` when both apply.
 */
export type ArchiveBlock = "reply-running" | "approval-pending";

/**
 * What this client knows that stops an archive: a pending approval, or a reply that runs or waits
 * in the queue. `live` is whether the hub says the channel's run is busy, for a channel whose
 * messages are not loaded. The hub checks again and refuses when the client did not know.
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
 * The channel to open after the open one is archived: the one below it, else the one above, else
 * none, which opens the fresh page.
 */
export const nextChannel = (channels: ReadonlyArray<Channel>, archived: ChannelId): Channel | undefined => {
  const index = channels.findIndex((channel) => channel.id === archived);
  if (index === -1) return undefined;
  return channels[index + 1] ?? channels[index - 1];
};

interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** ⌃⌘A on a Mac, Ctrl+Alt+A elsewhere: archives the open channel. */
export const isArchiveKey = (event: KeyLike): boolean =>
  event.code === "KeyA" && event.ctrlKey && (event.metaKey || event.altKey) && !event.shiftKey;

/** ⌘Z on a Mac, Ctrl+Z elsewhere: undoes the last archive while its toast shows. */
export const isUndoKey = (event: KeyLike): boolean =>
  event.code === "KeyZ" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;

/** Whether this is a Mac, whose shortcuts read ⌃⌘A and ⌘Z. */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "");
