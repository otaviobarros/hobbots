import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useHobPresence } from "../../api/hub-status.ts";
import { useKnownUnreadThreads } from "../../api/thread-reads.ts";
import { formatCount } from "../../lib/format.ts";
import { presenceState } from "../../lib/hob-state.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { type SidebarState, sidebarState } from "./hob-mark.ts";
import { messages as copy } from "./messages.ts";
import { sidebarCount, sidebarMore, sidebarRow, sidebarRule, sidebarSection } from "./sidebar-classes.ts";
import type { SidebarData } from "./sidebar-data.ts";
import { SidebarTip } from "./sidebar-item.tsx";
import { type DirectRow, directRows, rowTime, unreadCount } from "./sidebar-rows.ts";

/** The state dot on a hob's face: lantern when it needs you, mint while it works, a ring while paused. */
const DOT: Partial<Record<SidebarState, string>> = {
  "needs-you": "bg-lantern",
  working: "bg-mint",
  paused: "bg-panel shadow-[inset_0_0_0_2px_var(--color-control)]",
};

/** Whether the address is the hob's page or its direct message. */
const isOpen = (pathname: string, row: DirectRow) =>
  pathname === `/hobs/${row.hob.id}` ||
  pathname === `/hobs/${row.hob.id}/chat` ||
  (row.chat !== undefined && pathname === `/hobs/${row.hob.id}/threads/${row.chat.id}`);

/**
 * Direct messages (ADR 039, The sidebar): one row per hob, with its state dot, its last line and its
 * time, closed by All your hobs. A hob's row opens its chat. The + summons a hob.
 */
export function SidebarHobs({ data, pathname, wide }: { data: SidebarData; pathname: string; wide: boolean }) {
  const rows = directRows({ hobs: data.hobs, places: data.read?.sidebar.directMessages ?? [], threads: data.threads });
  return (
    <>
      <div className={sidebarSection}>
        <b className="lbl flex-1 text-detail">{copy.directMessages}</b>
        <Link
          to="/summon"
          aria-label={copy.summonLabel}
          className="inline-flex size-6 items-center justify-center rounded-control text-text-secondary hover:bg-hover hover:text-text-strong"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
          >
            <path d="M8 3v10M3 8h10" />
          </svg>
        </Link>
      </div>
      <span aria-hidden className={sidebarRule} />
      {data.failed && <p className="px-3 text-detail text-rose max-wide:hidden">{copy.hobsLoadFailed}</p>}
      <ul aria-label={copy.directMessages} className="m-0 flex w-full list-none flex-col items-center gap-0.5 p-0">
        {rows.map((row) => (
          <li key={row.hob.id} className="flex w-full justify-center">
            <DirectLink row={row} current={isOpen(pathname, row)} wide={wide} />
          </li>
        ))}
      </ul>
      <Link to="/hobs" aria-current={pathname === "/hobs" ? "page" : undefined} className={sidebarMore}>
        {copy.allHobs}
      </Link>
    </>
  );
}

function DirectLink({ row, current, wide }: { row: DirectRow; current: boolean; wide: boolean }) {
  const presence = useHobPresence();
  const known = useKnownUnreadThreads();
  const { hob, place, chat } = row;
  const state = sidebarState(presenceState(presence[hob.id], hob.status));
  const word = copy.state[state];
  const unread = place === undefined ? 0 : unreadCount(place, known);
  const needs = state === "needs-you";
  const line = needs || state === "working" || chat?.lastLine == null ? word : chat.lastLine;
  const dot = DOT[state];
  return (
    <SidebarTip label={copy.hob({ name: hob.name, state: word, unread: unread > 0 })} wide={wide}>
      <Link
        to="/hobs/$hobId/chat"
        params={{ hobId: hob.id }}
        aria-label={copy.hob({ name: hob.name, state: word, unread: unread > 0 })}
        aria-current={current ? "page" : undefined}
        className={cn(sidebarRow, "min-h-12")}
      >
        <span aria-hidden className="relative inline-flex size-hob-tile items-center justify-center max-wide:size-7.5">
          <span className="hidden wide:inline-flex">
            <HobTile hob={hob} tile="lg" />
          </span>
          <span className="inline-flex wide:hidden">
            <HobTile hob={hob} tile="md" />
          </span>
          {dot !== undefined && (
            <span className={cn("absolute -end-px -bottom-px size-[11px] rounded-dot border-2 border-panel", dot)} />
          )}
        </span>
        <span aria-hidden className="flex min-w-0 flex-col max-wide:hidden">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-ui font-semibold">{hob.name}</span>
            {chat !== undefined && (
              <span className="ms-auto flex-none text-meta text-label">{rowTime(chat.updatedAt)}</span>
            )}
          </span>
          <span
            className={cn(
              "truncate text-detail",
              needs ? "text-lantern" : unread > 0 ? "font-semibold text-text-strong" : "text-text-secondary",
            )}
          >
            {line}
          </span>
        </span>
        <span aria-hidden className="flex items-center max-wide:hidden">
          {unread > 0 && <span className={sidebarCount}>{formatCount(unread)}</span>}
        </span>
      </Link>
    </SidebarTip>
  );
}
