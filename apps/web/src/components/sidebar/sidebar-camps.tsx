import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useKnownUnreadChannels } from "../../api/channel-reads.ts";
import { formatCount } from "../../lib/format.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { campList, foldedNews } from "./camp-list.ts";
import { messages as copy } from "./messages.ts";
import { sidebarCount, sidebarMore, sidebarRule, sidebarSection } from "./sidebar-classes.ts";
import type { SidebarData } from "./sidebar-data.ts";
import { FaceStack } from "./sidebar-faces.tsx";
import { SidebarFailed } from "./sidebar-failed.tsx";
import { SidebarTip } from "./sidebar-item.tsx";
import { RailUnread, SidebarRowFrame, sidebarRowLink } from "./sidebar-row.tsx";
import { type CampRow, campRows, rowTime } from "./sidebar-rows.ts";
import { SidebarEmpty, SidebarLoading } from "./sidebar-states.tsx";

/** The camp the address names, if any. */
const openCampOf = (pathname: string) => /^\/hobs\/[^/]+\/channels\/([^/]+)/.exec(pathname)?.[1];

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
    channels: data.channels,
    hobs: data.hobs,
    you: data.read?.you,
    people: data.read?.people ?? [],
    unread: useKnownUnreadChannels(),
  });
  const open = openCampOf(pathname);
  const folded = campList(
    rows.map((row) => ({ ...row, id: row.channel.id })),
    open,
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
      <CampsList data={data} rows={rows} shown={shown} open={open} wide={wide} />
      {wide && folded.hidden.length > 0 && <ShowMore all={all} hidden={folded.hidden} onToggle={() => setAll(!all)} />}
    </>
  );
}

/** The camps, or still rows while none are read yet, or a line saying there are none. */
function CampsList({
  data,
  rows,
  shown,
  open,
  wide,
}: {
  data: SidebarData;
  rows: ReadonlyArray<CampRow>;
  shown: ReadonlyArray<CampRow>;
  open: string | undefined;
  wide: boolean;
}) {
  if (rows.length === 0 && data.campsLoading) return <SidebarLoading label={copy.camps} />;
  if (rows.length === 0 && !data.campsFailed) return <SidebarEmpty message={copy.noCamps} />;
  return (
    <ul aria-label={copy.camps} className="m-0 flex w-full list-none flex-col items-center gap-0.5 p-0">
      {shown.map((row) => (
        <li key={row.channel.id} className="flex w-full justify-center">
          <CampLink row={row} current={row.channel.id === open} wide={wide} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Show N more, or Show fewer, under the first camps. While folded, a dot shows that a hidden camp
 * holds what you have not read, as the rail's dot does: lantern for a mention of you. Its description
 * says so.
 */
function ShowMore({ all, hidden, onToggle }: { all: boolean; hidden: ReadonlyArray<CampRow>; onToggle: () => void }) {
  const { unread, mentions } = foldedNews(all ? [] : hidden);
  const news = copy.campNews({ unread, mentions, needs: false });
  return (
    <button
      type="button"
      aria-expanded={all}
      aria-description={news === "" ? undefined : news}
      className={sidebarMore}
      onClick={onToggle}
    >
      {all ? copy.fewerCamps : copy.moreCamps({ count: hidden.length })}
      {news !== "" && (
        <span
          aria-hidden
          className={cn("size-2 flex-none rounded-dot", mentions > 0 ? "bg-lantern" : "bg-text-strong")}
        />
      )}
    </button>
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
  const { place, channel, hob, needs } = row;
  const shared = place.section === "shared-camp";
  const news = copy.campNews({ unread: row.unread, mentions: place.mentions, needs });
  return (
    <SidebarRowFrame
      tall={shared}
      face={<CampFace row={row} wide={wide} />}
      link={
        <SidebarTip label={channel.title} wide={wide}>
          <Link
            to="/hobs/$hobId/channels/$channelId"
            params={{ hobId: hob.id, channelId: channel.id }}
            aria-current={current ? "page" : undefined}
            // The link keeps the camp's name as its name; what is new is told as its description.
            aria-label={channel.title}
            aria-description={news === "" ? undefined : news}
            className={cn(sidebarRowLink, shared || row.unread > 0 ? "font-semibold" : "font-normal")}
          >
            <span className="max-wide:sr-only">{channel.title}</span>
          </Link>
        </SidebarTip>
      }
      line={shared && channel.lastLine !== null ? <CampLine row={row} /> : undefined}
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

/**
 * A shared camp's last line after who wrote it, "Marina: one caption idea each?", in bold while it
 * holds what you have not read.
 */
function CampLine({ row }: { row: CampRow }) {
  const line = row.channel.lastLine ?? "";
  return (
    <span className={cn(row.unread > 0 ? "font-semibold text-text-strong" : "text-text-secondary")}>
      {row.lastAuthor === null ? line : copy.lastLine({ author: row.lastAuthor, line })}
    </span>
  );
}

/** A shared camp's time, or the hob whose camp it is; then Needs you, `@` for a mention of you, and the unread count. */
function CampAside({ row }: { row: CampRow }) {
  const shared = row.place.section === "shared-camp";
  const aside = shared ? rowTime(row.channel.updatedAt) : row.needs ? "" : row.hob.name;
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
