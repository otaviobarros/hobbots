import type { MessageId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hobbots/ui/components/menu";
import { useQuery } from "@tanstack/react-query";
import { pinsQuery, useSetPinned } from "../../api/notes.ts";
import { messages } from "./messages.ts";

const copy = messages.menu;

/**
 * A message's ⋯ menu (ADR 037): Pin or Unpin, which lists it under Mine, and Split here when the
 * message can start a chapter. A pinned message shows its ◆ beside the menu.
 */
export function MessageMenu({
  threadId,
  messageId,
  onSplit,
}: {
  threadId: ThreadId;
  messageId: MessageId;
  /** Left out where the message cannot start a chapter, such as a chapter's first. */
  onSplit?: (() => void) | undefined;
}) {
  const pins = useQuery(pinsQuery(threadId));
  const setPinned = useSetPinned(threadId);
  const pinned = pins.data?.some((pin) => pin.messageId === messageId) ?? false;
  const pending = setPinned.isPending && setPinned.variables?.messageId === messageId;
  const done = setPinned.isSuccess && setPinned.variables?.messageId === messageId;
  return (
    <>
      {pinned && (
        <span role="img" aria-label={messages.pinned} title={messages.pinned} className="text-meta text-lantern">
          {messages.pinMark}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="quiet" size="icon" aria-label={copy.more} title={copy.more}>
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={pending || pins.data === undefined}
            onSelect={() => setPinned.mutate({ messageId, pinned: !pinned })}
          >
            {pending ? copy.pinning : pinned ? copy.unpin : copy.pin}
          </DropdownMenuItem>
          {onSplit && <DropdownMenuItem onSelect={onSplit}>{copy.split}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* What the pin did, said once it is done, and why it failed otherwise. */}
      <span role="status" className="sr-only">
        {done ? (setPinned.data === null ? messages.unpinnedToast : messages.pinnedToast) : ""}
      </span>
      {setPinned.isError && setPinned.variables?.messageId === messageId && (
        <span role="alert" className="text-meta text-rose">
          {messages.pinFailed}
        </span>
      )}
    </>
  );
}
