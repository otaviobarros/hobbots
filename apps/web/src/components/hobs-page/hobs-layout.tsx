import type { AgentId, ChannelId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { channelsQuery } from "../../api/queries.ts";
import { ArchiveToastViewport } from "../archive/archive-toast.tsx";
import { ChannelMain, type WorkspaceMainProps } from "../archived-channels/archived-channels.tsx";
import { usePins } from "../quest/use-work.ts";
import { ChatColumn, FoldButton } from "../quest-sheet/chat-column.tsx";
import type { QuestView } from "../quest-sheet/quest-search.ts";
import { QuestWorkbench } from "../quest-sheet/quest-workbench.tsx";
import { useChatFold, useRoomWidth } from "../quest-sheet/use-chat-fold.ts";

interface WorkspaceProps {
  hobId: AgentId;
  channelId?: ChannelId | undefined;
  /** A message to scroll to and mark, such as a search match. */
  focusMessageId?: string | undefined;
  main?: ((props: WorkspaceMainProps) => ReactNode) | undefined;
  /** The quest the address opens: in the chat's sheet, or its Workbench beside the chat (ADR 037). */
  quest?: QuestView | undefined;
  /** What sits at the end, such as a hob page's side column. */
  aside?: ReactNode | null;
}

/**
 * The chat workspace, where a quest's Workbench opens beside the chat; the quest itself opens in the
 * chat's sheet, which the chat's header holds. The middle is the channel's chat
 * unless the route fills it with `main`, such as the hob's archived channels. Channels are archived
 * from their menus or with ⌃⌘A, with Undo in a toast that the app shell holds, so it stays when
 * archiving the last chat opens the hob's fresh page.
 */
export function HobsLayout({
  hobId,
  channelId,
  focusMessageId,
  main = (props) => <ChannelMain {...props} />,
  quest,
  aside,
}: WorkspaceProps) {
  // Pinned Quests show in every channel's header and open in its sheet.
  const pins = usePins();
  useChannelKeys(hobId, channelId);
  const width = useRoomWidth();
  const fold = useChatFold(width);
  const open = channelId !== undefined && quest?.tab !== undefined;

  return (
    <div className="flex min-w-0 flex-1">
      {/* The chat reads data-room to give up its minimum width in the column beside the Workbench. */}
      <div className="group/room relative flex min-w-0 flex-1" data-room={open ? "open" : undefined}>
        {open && <QuestWorkbench hobId={hobId} channelId={channelId} view={quest} pins={pins} />}
        <ChatColumn
          hobId={hobId}
          channelId={channelId}
          room={open}
          folded={fold.folded}
          width={width}
          onFold={fold.setFolded}
        >
          {main({
            hobId,
            channelId,
            focusMessageId,
            pins,
            headerEnd: open ? <FoldButton onFold={() => fold.setFolded(true)} /> : undefined,
            // Folded away beside the Workbench, the chat is out of view and reads nothing (ADR 027).
            inView: !(open && fold.folded),
            room: open,
          })}
        </ChatColumn>
        {/* With the chat folded away, a toast shows over the Workbench. */}
        {open && fold.folded && (
          <div className="absolute inset-x-0 bottom-6 z-10 mx-auto w-full max-w-[520px] empty:hidden">
            <ArchiveToastViewport />
          </div>
        )}
      </div>
      {aside}
    </div>
  );
}

/** ⌥↑ and ⌥↓ move between the current hob's channels. */
const useChannelKeys = (hobId: AgentId, channelId: ChannelId | undefined) => {
  const channels = useQuery(channelsQuery(hobId));
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const list = channels.data ?? [];
      if (list.length === 0) return;
      const index = list.findIndex((t) => t.id === channelId);
      const step = event.key === "ArrowUp" ? -1 : 1;
      const target = list[index === -1 ? 0 : (index + step + list.length) % list.length];
      if (!target) return;
      event.preventDefault();
      void navigate({ to: "/hobs/$hobId/channels/$channelId", params: { hobId, channelId: target.id } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [channels.data, channelId, hobId, navigate]);
};
