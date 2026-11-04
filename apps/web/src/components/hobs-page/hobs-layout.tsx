import type { AgentId, ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { threadsQuery } from "../../api/queries.ts";
import { ThreadMain, type WorkspaceMainProps } from "../archived-threads/archived-threads.tsx";
import { usePins } from "../quest/use-work.ts";
import { ChatColumn, FoldButton } from "../quest-room/chat-column.tsx";
import { QuestRoom } from "../quest-room/quest-room.tsx";
import type { RoomView } from "../quest-room/room-search.ts";
import { useChatFold, useRoomWidth } from "../quest-room/use-chat-fold.ts";

interface WorkspaceProps {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  /** A message to scroll to and mark, such as a search match. */
  focusMessageId?: string | undefined;
  main?: ((props: WorkspaceMainProps) => ReactNode) | undefined;
  /** The Quest room to open beside the chat (ADR 027). */
  room?: RoomView | undefined;
  /** What sits at the end, such as a hob page's side column. */
  aside?: ReactNode | null;
}

/**
 * The chat workspace, where the Quest room opens beside the chat. The middle is the thread's chat
 * unless the route fills it with `main`, such as the hob's archived threads. Threads are archived
 * from their menus or with ⌃⌘A, with Undo in a toast that the app shell holds, so it stays when
 * archiving the last chat opens the hob's fresh page.
 */
export function HobsLayout({
  hobId,
  threadId,
  focusMessageId,
  main = (props) => <ThreadMain {...props} />,
  room,
  aside,
}: WorkspaceProps) {
  // Pinned Quests show in every thread's header and open in its room.
  const pins = usePins();
  useThreadKeys(hobId, threadId);
  const width = useRoomWidth();
  const fold = useChatFold(width);
  const open = threadId !== undefined && room !== undefined;

  return (
    <div className="flex min-w-0 flex-1">
      {/* The chat reads data-room to give up its minimum width in the room's column. */}
      <div className="group/room relative flex min-w-0 flex-1" data-room={open ? "open" : undefined}>
        {open && <QuestRoom hobId={hobId} threadId={threadId} view={room} pins={pins} width={width} />}
        <ChatColumn
          hobId={hobId}
          threadId={threadId}
          room={open}
          folded={fold.folded}
          width={width}
          onFold={fold.setFolded}
        >
          {main({
            hobId,
            threadId,
            focusMessageId,
            pins,
            headerEnd: open ? <FoldButton onFold={() => fold.setFolded(true)} /> : undefined,
            // Folded away beside the room, the chat is out of view and reads nothing (ADR 027).
            inView: !(open && fold.folded),
            room: open,
          })}
        </ChatColumn>
      </div>
      {aside}
    </div>
  );
}

/** ⌥↑ and ⌥↓ move between the current hob's threads. */
const useThreadKeys = (hobId: AgentId, threadId: ThreadId | undefined) => {
  const threads = useQuery(threadsQuery(hobId));
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const list = threads.data ?? [];
      if (list.length === 0) return;
      const index = list.findIndex((t) => t.id === threadId);
      const step = event.key === "ArrowUp" ? -1 : 1;
      const target = list[index === -1 ? 0 : (index + step + list.length) % list.length];
      if (!target) return;
      event.preventDefault();
      void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId: target.id } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [threads.data, threadId, hobId, navigate]);
};
