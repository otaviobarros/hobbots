import { type Agent, type Channel, ChannelLifecycle } from "@hobbots/domain";
import { DropdownMenuItem } from "@hobbots/ui/components/menu";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { usePinChannel } from "../../api/channel-settings.ts";
import { messages as campCopy } from "../camps/messages.ts";
import {
  CampMenuIcon,
  DoorIcon,
  FreshMenuIcon,
  PinMenuIcon,
  RenameIcon,
  SearchMenuIcon,
  SlidersIcon,
} from "../chat/chat-icons.tsx";
import { messages as searchCopy } from "../find/messages.ts";
import { messages as appCopy } from "../messages.ts";
import { messages as copy } from "./messages.ts";

// The items of the chat header's ⋯ menu that act on the channel, its camps and its hob.

const chatCopy = appCopy.chat;

/** A menu item's first line: its icon, then its label. */
export const Line = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <span className="flex items-center gap-2.5">
    {icon}
    {children}
  </span>
);

/**
 * Rename and pin for a camp, then search, for a channel that exists. The hob's chat has no title of
 * its own to rename and always leads the hob's list, so it has neither.
 */
export function ChannelItems({
  channel,
  onRename,
  onSearch,
}: {
  channel: Channel;
  onRename: () => void;
  onSearch: () => void;
}) {
  const pin = usePinChannel();
  const pinned = channel.pinnedAt !== null;
  return (
    <>
      {channel.kind === "camp" && (
        <>
          <DropdownMenuItem onSelect={onRename}>
            <Line icon={<RenameIcon />}>{copy.rename}</Line>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pin.mutate({ channel, value: !pinned })}>
            <Line icon={<PinMenuIcon />}>{pinned ? copy.unpin : copy.pin}</Line>
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuItem onSelect={onSearch}>
        <Line icon={<SearchMenuIcon />}>{searchCopy.open}</Line>
      </DropdownMenuItem>
    </>
  );
}

/**
 * Make a camp, and Start a fresh chat on the hob's open chat (ADR 037). Each opens its sheet once
 * the menu has closed.
 */
export function CampItems({
  channel,
  onMakeCamp,
  onStartFresh,
}: {
  channel: Channel | undefined;
  onMakeCamp: () => void;
  onStartFresh: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onMakeCamp}>
        <Line icon={<CampMenuIcon />}>{campCopy.menu.makeCamp}</Line>
      </DropdownMenuItem>
      {channel !== undefined && ChannelLifecycle.isOpenChat(channel) && (
        <DropdownMenuItem onSelect={onStartFresh}>
          <Line icon={<FreshMenuIcon />}>{campCopy.menu.startFresh}</Line>
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The hob's page and its profile, where Edit hob goes. */
export function HobItems({ hob }: { hob: Agent }) {
  return (
    <>
      <DropdownMenuItem asChild>
        <Link to="/hobs/$hobId" params={{ hobId: hob.id }} className="text-inherit no-underline">
          <Line icon={<DoorIcon />}>{copy.hobPage({ name: hob.name })}</Line>
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} className="text-inherit no-underline">
          <Line icon={<SlidersIcon />}>{chatCopy.editHob}</Line>
        </Link>
      </DropdownMenuItem>
    </>
  );
}
