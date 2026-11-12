import { type Agent, type Thread, ThreadLifecycle } from "@hobbots/domain";
import { DropdownMenuItem } from "@hobbots/ui/components/menu";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { usePinThread } from "../../api/thread-settings.ts";
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

// The items of the chat header's ⋯ menu that act on the thread, its camps and its hob.

const chatCopy = appCopy.chat;

/** A menu item's first line: its icon, then its label. */
export const Line = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <span className="flex items-center gap-2.5">
    {icon}
    {children}
  </span>
);

/**
 * Rename and pin for a camp, then search, for a thread that exists. The hob's chat has no title of
 * its own to rename and always leads the hob's list, so it has neither.
 */
export function ThreadItems({
  thread,
  onRename,
  onSearch,
}: {
  thread: Thread;
  onRename: () => void;
  onSearch: () => void;
}) {
  const pin = usePinThread();
  const pinned = thread.pinnedAt !== null;
  return (
    <>
      {thread.kind === "camp" && (
        <>
          <DropdownMenuItem onSelect={onRename}>
            <Line icon={<RenameIcon />}>{copy.rename}</Line>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pin.mutate({ thread, value: !pinned })}>
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
  thread,
  onMakeCamp,
  onStartFresh,
}: {
  thread: Thread | undefined;
  onMakeCamp: () => void;
  onStartFresh: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onMakeCamp}>
        <Line icon={<CampMenuIcon />}>{campCopy.menu.makeCamp}</Line>
      </DropdownMenuItem>
      {thread !== undefined && ThreadLifecycle.isOpenChat(thread) && (
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
