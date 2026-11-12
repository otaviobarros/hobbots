import type { MessageId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hobbots/ui/components/menu";
import { useQuery } from "@tanstack/react-query";
import { pinsQuery, useSetPinned } from "../../api/notes.ts";
import { messages } from "./messages.ts";

const copy = messages.menu;

const pinLabel = (pending: boolean, pinned: boolean): string => {
  if (pending) return copy.pinning;
  return pinned ? copy.unpin : copy.pin;
};

/** What a done pin says: the hub answers null for an unpin. */
const pinSaid = (pin: unknown): string => (pin === null ? messages.unpinnedToast : messages.pinnedToast);

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
  const ofThis = setPinned.variables?.messageId === messageId;
  const pending = setPinned.isPending && ofThis;
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
            {pinLabel(pending, pinned)}
          </DropdownMenuItem>
          {onSplit && <DropdownMenuItem onSelect={onSplit}>{copy.split}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* What the pin did, said once it is done, and why it failed otherwise. */}
      <span role="status" className="sr-only">
        {setPinned.isSuccess && ofThis ? pinSaid(setPinned.data) : ""}
      </span>
      {setPinned.isError && ofThis && (
        <span role="alert" className="text-meta text-rose">
          {messages.pinFailed}
        </span>
      )}
    </>
  );
}
