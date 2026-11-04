import type { AgentId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { agentsQuery, messagesQuery } from "../../api/queries.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";
import { FoldIcon, UnfoldIcon } from "./room-icons.tsx";
import type { RoomWidth } from "./use-chat-fold.ts";

const copy = messages.chat;

/** Where the chat sits: the whole middle, a column beside the room, over the lanes, or folded away. */
const placeOf = (room: boolean, folded: boolean, width: RoomWidth) => {
  if (!room) return "flex min-w-0 flex-1";
  if (folded) return "invisible absolute inset-y-0 end-0 flex w-room-chat";
  if (width === "narrow")
    return "absolute inset-y-0 end-0 z-30 flex w-room-chat border-s border-line bg-ground shadow-sheet";
  return cn("flex shrink-0 border-s border-line", width === "wide" ? "w-room-chat" : "w-room-chat-narrow");
};

/**
 * The thread beside the Quest room (ADR 027): the same chat, never mounted again, so it keeps its
 * scroll position and unsent message as the room opens and closes. Folded, it stays in the page out
 * of sight and out of focus, and a rail with the lead's tile takes its place, with a dot once the
 * lead writes while it is folded.
 */
export function ChatColumn({
  hobId,
  threadId,
  room,
  folded,
  width,
  onFold,
  children,
}: {
  hobId: AgentId;
  threadId: ThreadId | undefined;
  /** Whether the room is open beside the chat. */
  room: boolean;
  folded: boolean;
  width: RoomWidth;
  onFold: (folded: boolean) => void;
  children: ReactNode;
}) {
  const replies = useQuery({
    ...messagesQuery(threadId ?? ("" as ThreadId)),
    enabled: threadId !== undefined,
    select: (all) => all.filter((message) => message.role === "assistant").length,
  }).data;
  const hidden = room && folded;
  // How many replies the chat held while it was last in view; a reply after that leaves the dot.
  const [seen, setSeen] = useState(replies);
  if (replies !== undefined && (seen === undefined || (!hidden && seen !== replies))) setSeen(replies);
  return (
    <>
      <div className={placeOf(room, folded, width)} inert={hidden} aria-hidden={hidden || undefined}>
        {children}
      </div>
      {hidden && (
        <Rail
          hobId={hobId}
          unread={replies !== undefined && seen !== undefined && replies > seen}
          onOpen={() => onFold(false)}
        />
      )}
    </>
  );
}

/** The fold button the chat's header ends with while the room is open. */
export function FoldButton({ onFold }: { onFold: () => void }) {
  return (
    <Button variant="icon" size="icon" aria-label={copy.fold} title={copy.foldHint} onClick={onFold}>
      <FoldIcon />
    </Button>
  );
}

/** The folded chat: Open the chat and the lead's tile, with a dot when it wrote since the fold. */
function Rail({ hobId, unread, onOpen }: { hobId: AgentId; unread: boolean; onOpen: () => void }) {
  const hob = useQuery({ ...agentsQuery, select: (all) => all.find((each) => each.id === hobId) }).data;
  const name = hob?.name ?? "";
  return (
    <aside
      aria-label={copy.folded}
      className="flex w-room-rail shrink-0 flex-col items-center gap-3 border-s border-line bg-panel pt-3"
    >
      <Button variant="ghost" size="icon" aria-label={copy.open} title={copy.open} onClick={onOpen}>
        <UnfoldIcon />
      </Button>
      {hob !== undefined &&
        (unread ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={copy.unread({ name })}
            className="relative cursor-pointer rounded-tile border-0 bg-transparent p-0"
          >
            <HobTile hob={hob} tile="md" />
            <span
              aria-hidden
              className="absolute -end-1 -top-1 size-2.5 rounded-dot border-(length:--edge) border-panel bg-lantern"
            />
          </button>
        ) : (
          <HobTile hob={hob} tile="md" />
        ))}
      {unread && (
        <span className="text-meta font-bold text-lantern [writing-mode:vertical-rl]">{copy.newFrom({ name })}</span>
      )}
    </aside>
  );
}
