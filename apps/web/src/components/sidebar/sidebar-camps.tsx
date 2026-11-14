import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useThreadReplies } from "../../api/hub-status.ts";
import { useKnownUnreadThreads } from "../../api/thread-reads.ts";
import { formatCount } from "../../lib/format.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { campList } from "./camp-list.ts";
import { messages as copy } from "./messages.ts";
import { sidebarCount, sidebarMore, sidebarRow, sidebarRule, sidebarSection } from "./sidebar-classes.ts";
import type { SidebarData } from "./sidebar-data.ts";
import { FaceStack } from "./sidebar-faces.tsx";
import { SidebarTip } from "./sidebar-item.tsx";
import { type CampRow, campRows, rowTime } from "./sidebar-rows.ts";

/** The camp the address names, if any. */
const openCampOf = (pathname: string) => /^\/hobs\/[^/]+\/threads\/([^/]+)/.exec(pathname)?.[1];

/**
 * Camps (ADR 039, The sidebar): the camps you share first, as rows with stacked faces, the last line
 * and its time, then the camps a hob runs alone with you, as compact rows. The first five show, and
 * the open one, with Show N more for the rest. The + makes a camp.
 */
export function SidebarCamps({
  data,
  pathname,
  wide,
  onMake,
}: {
  data: SidebarData;
  pathname: string;
  wide: boolean;
  onMake: (() => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const replies = useThreadReplies();
  const rows = campRows({
    places: data.read?.sidebar.camps ?? [],
    threads: data.threads,
    hobs: data.hobs,
    people: data.read?.people ?? [],
    replies,
    unread: useKnownUnreadThreads(),
  });
  const open = openCampOf(pathname);
  const unread = new Set(rows.filter((row) => row.unread > 0).map((row) => row.thread.id));
  const folded = campList(
    rows.map((row) => ({ ...row, id: row.thread.id })),
    open,
    unread,
  );
  const shown = all ? rows : folded.shown;
  return (
    <>
      <div className={sidebarSection}>
        <b className="lbl flex-1 text-detail">{copy.camps}</b>
        {onMake !== undefined && <MakeButton onMake={onMake} />}
      </div>
      <span aria-hidden className={sidebarRule} />
      <ul aria-label={copy.camps} className="m-0 flex w-full list-none flex-col items-center gap-0.5 p-0">
        {shown.map((row) => (
          <li key={row.thread.id} className="flex w-full justify-center">
            <CampLink row={row} current={row.thread.id === open} wide={wide} />
          </li>
        ))}
      </ul>
      {folded.hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          aria-description={
            !all && folded.hiddenUnread ? copy.campNews({ unread: 1, mentions: 0, needs: false }) : undefined
          }
          className={sidebarMore}
          onClick={() => setAll(!all)}
        >
          {all ? copy.fewerCamps : copy.moreCamps({ count: folded.hidden })}
        </button>
      )}
    </>
  );
}

/** The + beside Camps. */
function MakeButton({ onMake }: { onMake: () => void }) {
  return (
    <button
      type="button"
      aria-label={copy.makeCamp}
      onClick={onMake}
      className="inline-flex size-6 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-secondary hover:bg-hover hover:text-text-strong"
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
    </button>
  );
}

/** A camp's row: shared ones with their faces and last line, a hob's own compact with its tile. */
function CampLink({ row, current, wide }: { row: CampRow; current: boolean; wide: boolean }) {
  const { place, thread, hob, needs } = row;
  const news = copy.campNews({ unread: row.unread, mentions: place.mentions, needs });
  return (
    <SidebarTip label={thread.title} wide={wide}>
      <Link
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: hob.id, threadId: thread.id }}
        aria-current={current ? "page" : undefined}
        // The link keeps the camp's name as its name; what is new is told as its description.
        aria-label={thread.title}
        aria-description={news === "" ? undefined : news}
        className={cn(sidebarRow, place.section === "shared-camp" ? "min-h-12" : "min-h-[34px] py-[3px]")}
      >
        <CampFace row={row} wide={wide} />
        <CampText row={row} />
        <CampMarks row={row} />
      </Link>
    </SidebarTip>
  );
}

/** A shared camp's stack of faces, or the hob's tile; on the rail, a lantern dot when it needs you. */
function CampFace({ row, wide }: { row: CampRow; wide: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-hob-tile items-center justify-center max-wide:size-7.5">
      {row.place.section === "shared-camp" ? <FaceStack faces={row.faces} /> : <HobTile hob={row.hob} tile="sm" />}
      {!wide && row.needs && (
        <span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-dot border-(length:--edge) border-panel bg-lantern" />
      )}
    </span>
  );
}

/** The camp's name and, for a shared camp, its time and last line; for a hob's own, the hob's name. */
function CampText({ row }: { row: CampRow }) {
  const { thread, hob, needs } = row;
  const shared = row.place.section === "shared-camp";
  const unread = row.unread > 0;
  const aside = shared ? rowTime(thread.updatedAt) : needs ? "" : hob.name;
  return (
    <span aria-hidden className="flex min-w-0 flex-col max-wide:hidden">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn("truncate text-ui", shared || unread ? "font-semibold" : "font-normal")}>
          {thread.title}
        </span>
        <span className="ms-auto flex-none text-meta text-label">{aside}</span>
      </span>
      {shared && thread.lastLine !== null && (
        <span className={cn("truncate text-detail", unread ? "font-semibold text-text-strong" : "text-text-secondary")}>
          {thread.lastLine}
        </span>
      )}
    </span>
  );
}

/** Needs you, `@` for a mention of you, and the unread count. */
function CampMarks({ row }: { row: CampRow }) {
  return (
    <span aria-hidden className="flex items-center gap-1 max-wide:hidden">
      {row.needs && (
        <span className="rounded-tag bg-[color-mix(in_srgb,var(--color-lantern)_22%,transparent)] px-[7px] py-px text-meta font-semibold whitespace-nowrap text-lantern">
          {copy.needsYou}
        </span>
      )}
      {row.place.mentions > 0 && <span className={cn(sidebarCount, "bg-lantern text-on-lantern")}>{copy.mention}</span>}
      {row.unread > 0 && <span className={sidebarCount}>{formatCount(row.unread)}</span>}
    </span>
  );
}
