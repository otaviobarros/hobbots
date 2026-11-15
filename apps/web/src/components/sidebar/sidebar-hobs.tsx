import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useHobPresence } from "../../api/hub-status.ts";
import { useKnownUnreadChannels } from "../../api/channel-reads.ts";
import { formatCount } from "../../lib/format.ts";
import { presenceState } from "../../lib/hob-state.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { type SidebarState, sidebarState } from "./hob-mark.ts";
import { messages as copy } from "./messages.ts";
import { sidebarCount, sidebarMore, sidebarRule, sidebarSection } from "./sidebar-classes.ts";
import type { SidebarData } from "./sidebar-data.ts";
import { SidebarFailed } from "./sidebar-failed.tsx";
import { SidebarTip } from "./sidebar-item.tsx";
import { RailUnread, SidebarRowFrame, sidebarRowLink } from "./sidebar-row.tsx";
import { type DirectRow, directRows, rowTime, unreadCount } from "./sidebar-rows.ts";
import { SidebarEmpty, SidebarLoading } from "./sidebar-states.tsx";

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
  (row.chat !== undefined && pathname === `/hobs/${row.hob.id}/channels/${row.chat.id}`);

/**
 * Direct messages (ADR 039, The sidebar): one row per hob, with its state dot, its last line and its
 * time, closed by All your hobs. A hob's row opens its chat. The + summons a hob.
 */
export function SidebarHobs({ data, pathname, wide }: { data: SidebarData; pathname: string; wide: boolean }) {
  const rows = directRows({ hobs: data.hobs, places: data.read?.sidebar.directMessages ?? [], channels: data.channels });
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
      {data.hobsFailed && <SidebarFailed message={copy.hobsLoadFailed} onRetry={data.retry} />}
      {data.hobsLoading ? (
        <SidebarLoading label={copy.directMessages} />
      ) : (
        <ul aria-label={copy.directMessages} className="m-0 flex w-full list-none flex-col items-center gap-0.5 p-0">
          {rows.map((row) => (
            <li key={row.hob.id} className="flex w-full justify-center">
              <DirectLink row={row} current={isOpen(pathname, row)} wide={wide} />
            </li>
          ))}
        </ul>
      )}
      {!data.hobsLoading && !data.hobsFailed && rows.length === 0 && <SidebarEmpty message={copy.noHobs} />}
      <Link to="/hobs" aria-current={pathname === "/hobs" ? "page" : undefined} className={sidebarMore}>
        {copy.allHobs}
      </Link>
    </>
  );
}

function DirectLink({ row, current, wide }: { row: DirectRow; current: boolean; wide: boolean }) {
  const presence = useHobPresence();
  const known = useKnownUnreadChannels();
  const { hob, place, chat } = row;
  const state = sidebarState(presenceState(presence[hob.id], hob.status));
  const word = copy.state[state];
  const unread = place === undefined ? 0 : unreadCount(place, known);
  const needs = state === "needs-you";
  const line = needs || state === "working" || chat?.lastLine == null ? word : chat.lastLine;
  const name = copy.hob({ name: hob.name, state: word, unread: unread > 0 });
  return (
    <SidebarRowFrame
      tall
      face={
        <>
          <DirectFace hob={hob} state={state} />
          <RailUnread unread={unread > 0} mention={(place?.mentions ?? 0) > 0} />
        </>
      }
      link={
        <SidebarTip label={name} wide={wide}>
          <Link
            to="/hobs/$hobId/chat"
            params={{ hobId: hob.id }}
            aria-label={name}
            aria-current={current ? "page" : undefined}
            className={cn(sidebarRowLink, "font-semibold")}
          >
            <span className="max-wide:sr-only">{hob.name}</span>
          </Link>
        </SidebarTip>
      }
      line={
        <span
          className={cn(needs ? "text-lantern" : unread > 0 ? "font-semibold text-text-strong" : "text-text-secondary")}
        >
          {line}
        </span>
      }
      aside={
        <>
          {chat !== undefined && <span className="text-meta text-label">{rowTime(chat.updatedAt)}</span>}
          {unread > 0 && <span className={sidebarCount}>{formatCount(unread)}</span>}
        </>
      }
    />
  );
}

/** The hob's tile with its state dot: larger on the wide sidebar than on the rail. */
function DirectFace({ hob, state }: { hob: Agent; state: SidebarState }) {
  const dot = DOT[state];
  return (
    <>
      <span className="hidden wide:inline-flex">
        <HobTile hob={hob} tile="lg" />
      </span>
      <span className="inline-flex wide:hidden">
        <HobTile hob={hob} tile="md" />
      </span>
      {dot !== undefined && (
        <span
          className={cn("absolute -end-px -bottom-px size-[11px] rounded-dot border-(length:--edge) border-panel", dot)}
        />
      )}
    </>
  );
}
