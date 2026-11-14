import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useKnownUnreadThreads } from "../../api/thread-reads.ts";
import { formatCount } from "../../lib/format.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { campList } from "./camp-list.ts";
import { messages as copy } from "./messages.ts";
import { sidebarCount, sidebarMore, sidebarRule, sidebarSection } from "./sidebar-classes.ts";
import type { SidebarData } from "./sidebar-data.ts";
import { FaceStack } from "./sidebar-faces.tsx";
import { SidebarFailed } from "./sidebar-failed.tsx";
import { SidebarTip } from "./sidebar-item.tsx";
import { RailUnread, SidebarRowFrame, sidebarRowLink } from "./sidebar-row.tsx";
import { type CampRow, campRows, rowTime } from "./sidebar-rows.ts";

/** The camp the address names, if any. */
const openCampOf = (pathname: string) => /^\/hobs\/[^/]+\/threads\/([^/]+)/.exec(pathname)?.[1];

/**
 * Camps (ADR 039, The sidebar): the camps you share first, as rows with stacked faces, the last line
 * and its time, then the camps a hob runs alone with you, as compact rows. The first five show, and
 * the open one, with Show N more for the rest; the rail lists them all. The + makes a camp.
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
  const rows = campRows({
    places: data.read?.sidebar.camps ?? [],
    threads: data.threads,
    hobs: data.hobs,
    people: data.read?.people ?? [],
    unread: useKnownUnreadThreads(),
  });
  const open = openCampOf(pathname);
  const unread = new Set(rows.filter((row) => row.unread > 0).map((row) => row.thread.id));
  const folded = campList(
    rows.map((row) => ({ ...row, id: row.thread.id })),
    open,
    unread,
  );
  // The rail has no room for Show more, so it lists every camp and scrolls.
  const shown = all || !wide ? rows : folded.shown;
  return (
    <>
      <div className={sidebarSection}>
        <b className="lbl flex-1 text-detail">{copy.camps}</b>
        {onMake !== undefined && <MakeButton onMake={onMake} />}
      </div>
      <span aria-hidden className={sidebarRule} />
      {data.campsFailed && <SidebarFailed message={copy.campsLoadFailed} onRetry={data.retry} />}
      <ul aria-label={copy.camps} className="m-0 flex w-full list-none flex-col items-center gap-0.5 p-0">
        {shown.map((row) => (
          <li key={row.thread.id} className="flex w-full justify-center">
            <CampLink row={row} current={row.thread.id === open} wide={wide} />
          </li>
        ))}
      </ul>
      {wide && folded.hidden > 0 && (
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
  const shared = place.section === "shared-camp";
  const news = copy.campNews({ unread: row.unread, mentions: place.mentions, needs });
  return (
    <SidebarRowFrame
      tall={shared}
      face={<CampFace row={row} wide={wide} />}
      link={
        <SidebarTip label={thread.title} wide={wide}>
          <Link
            to="/hobs/$hobId/threads/$threadId"
            params={{ hobId: hob.id, threadId: thread.id }}
            aria-current={current ? "page" : undefined}
            // The link keeps the camp's name as its name; what is new is told as its description.
            aria-label={thread.title}
            aria-description={news === "" ? undefined : news}
            className={cn(sidebarRowLink, shared || row.unread > 0 ? "font-semibold" : "font-normal")}
          >
            <span className="max-wide:sr-only">{thread.title}</span>
          </Link>
        </SidebarTip>
      }
      line={shared && thread.lastLine !== null ? <CampLine row={row} /> : undefined}
      aside={<CampAside row={row} />}
    />
  );
}

/**
 * A shared camp's stack of faces, or the hob's tile; on the rail, a lantern dot when it needs you and
 * a dot for what you have not read.
 */
function CampFace({ row, wide }: { row: CampRow; wide: boolean }) {
  return (
    <>
      {row.place.section === "shared-camp" ? <FaceStack faces={row.faces} /> : <HobTile hob={row.hob} tile="sm" />}
      <RailUnread unread={row.unread > 0} mention={row.place.mentions > 0} />
      {!wide && row.needs && (
        <span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-dot border-(length:--edge) border-panel bg-lantern" />
      )}
    </>
  );
}

/** A shared camp's last line, in bold while it holds what you have not read. */
function CampLine({ row }: { row: CampRow }) {
  return (
    <span className={cn(row.unread > 0 ? "font-semibold text-text-strong" : "text-text-secondary")}>
      {row.thread.lastLine}
    </span>
  );
}

/** A shared camp's time, or the hob whose camp it is; then Needs you, `@` for a mention of you, and the unread count. */
function CampAside({ row }: { row: CampRow }) {
  const shared = row.place.section === "shared-camp";
  const aside = shared ? rowTime(row.thread.updatedAt) : row.needs ? "" : row.hob.name;
  return (
    <>
      {aside !== "" && <span className="text-meta text-label">{aside}</span>}
      <span className="flex items-center gap-1">
        {row.needs && (
          <span className="rounded-tag bg-lantern px-[7px] py-px text-meta font-semibold whitespace-nowrap text-on-lantern">
            {copy.needsYou}
          </span>
        )}
        {row.place.mentions > 0 && (
          <span className={cn(sidebarCount, "bg-lantern text-on-lantern")}>{copy.mention}</span>
        )}
        {row.unread > 0 && <span className={sidebarCount}>{formatCount(row.unread)}</span>}
      </span>
    </>
  );
}
