import type { Agent, Thread } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { campsOf, openChatOf } from "../../api/camps.ts";
import { threadsQuery } from "../../api/queries.ts";
import { MakeCampSheet } from "../camps/make-camp-sheet.tsx";
import { messages as campCopy } from "../camps/messages.ts";
import { campList } from "./camp-list.ts";
import { messages as copy } from "./messages.ts";
import { sidebarItem } from "./sidebar-classes.ts";

const sub = cn(sidebarItem, "animate-hb-in ps-14 pe-2 text-text-secondary hover:text-text-strong");

/** Where the open hob's chat is, as the address shows it: its own page, or the thread it is. */
const isChatAt = (pathname: string, hobId: string, chat: Thread | undefined) =>
  pathname === `/hobs/${hobId}/chat` || (chat !== undefined && pathname === `/hobs/${hobId}/threads/${chat.id}`);

/** The camp the address names, if any. */
const openCampOf = (pathname: string, hobId: string) =>
  pathname.startsWith(`/hobs/${hobId}/threads/`) ? pathname.split("/")[4] : undefined;

/**
 * Under the open hob, while the sidebar is expanded (ADR 037): its Chat first, then its camps,
 * pinned ones first, then Make a camp. Only the first five camps show, and the open one, with Show
 * N more for the rest, so a hob with many camps never pushes the other hobs away. A row with
 * messages you have not read carries the lantern dot, and so does Show more when it hides one.
 */
export function SidebarCamps({ hob, pathname }: { hob: Agent; pathname: string }) {
  const threads = useQuery(threadsQuery(hob.id));
  const chat = openChatOf(threads.data);
  const [making, setMaking] = useState(false);
  const [all, setAll] = useState(false);
  const camps = campsOf(threads.data);
  const folded = campList(camps, openCampOf(pathname, hob.id));
  const shown = all ? camps : folded.shown;
  return (
    <>
      <ul aria-label={campCopy.sidebar.camps({ name: hob.name })} className="m-0 flex list-none flex-col gap-0.5 p-0">
        <li className="flex">
          <Link
            to="/hobs/$hobId/chat"
            params={{ hobId: hob.id }}
            aria-current={isChatAt(pathname, hob.id, chat) ? "page" : undefined}
            aria-description={chat?.unread ? copy.unreadThread : undefined}
            className={sub}
          >
            <Glyph>{copy.glyph.chat}</Glyph>
            <span className="min-w-0 flex-1 truncate">{campCopy.sidebar.chat}</span>
            {chat?.unread && <UnreadDot />}
          </Link>
        </li>
        {shown.map((camp) => (
          <li key={camp.id} className="flex">
            <Link
              to="/hobs/$hobId/threads/$threadId"
              params={{ hobId: hob.id, threadId: camp.id }}
              aria-current={pathname === `/hobs/${hob.id}/threads/${camp.id}` ? "page" : undefined}
              // The link keeps the camp's title as its name, so the dot is told as its description.
              aria-description={camp.unread ? copy.unreadThread : undefined}
              className={sub}
            >
              <Glyph>{copy.glyph.camp}</Glyph>
              <span className="min-w-0 flex-1 truncate">{camp.title}</span>
              {camp.unread && <UnreadDot />}
            </Link>
          </li>
        ))}
        {folded.hidden > 0 && (
          <li className="flex">
            <button
              type="button"
              aria-expanded={all}
              aria-description={!all && folded.hiddenUnread ? copy.unreadThread : undefined}
              className={cn(sub, "cursor-pointer border-0 bg-transparent")}
              onClick={() => setAll(!all)}
            >
              <Glyph>{copy.glyph.more}</Glyph>
              <span className="min-w-0 flex-1 truncate">
                {all ? copy.fewerCamps : copy.moreCamps({ count: folded.hidden })}
              </span>
              {!all && folded.hiddenUnread && <UnreadDot />}
            </button>
          </li>
        )}
        <li className="flex">
          <button
            type="button"
            aria-label={campCopy.sidebar.makeCampFor({ name: hob.name })}
            className={cn(sub, "cursor-pointer border-0 bg-transparent")}
            onClick={() => setMaking(true)}
          >
            <Glyph>{copy.glyph.add}</Glyph>
            <span className="min-w-0 flex-1 truncate">{campCopy.sidebar.makeCamp}</span>
          </button>
        </li>
      </ul>
      {making && <MakeCampSheet hob={hob} onClose={() => setMaking(false)} />}
    </>
  );
}

function Glyph({ children }: { children: string }) {
  return (
    <span aria-hidden className="w-4 flex-none text-center text-meta text-label">
      {children}
    </span>
  );
}

function UnreadDot() {
  return <span aria-hidden className="size-2 flex-none rounded-dot bg-lantern" />;
}
