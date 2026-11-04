import type { Agent, AgentId } from "@hobbots/domain";
import { Popover, PopoverTrigger } from "@hobbots/ui/components/popover";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useActivity } from "../../api/activity.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { hobState, withRequests } from "../../lib/hob-state.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { HobCard } from "./hob-card.tsx";
import { type SidebarState, sidebarState } from "./hob-mark.ts";
import { messages as copy } from "./messages.ts";
import { SidebarTip, sidebarIcon, sidebarItem } from "./sidebar-item.tsx";

/** How many of the open hob's threads show under its name. */
const RECENT_THREADS = 5;

const MARK: Partial<Record<SidebarState, string>> = { "needs-you": "bg-lantern", working: "bg-mint" };

/** The hob whose page or chat is open, read from the address. */
const openHobOf = (pathname: string): string | undefined => /^\/hobs\/([^/]+)/.exec(pathname)?.[1];

/**
 * Every hob, each with a still state mark: lantern when it needs you, mint while it works. A hob's
 * tile opens its card. The hob whose page or chat is open lists its recent threads under its name
 * while the sidebar is expanded.
 */
export function SidebarHobs({ expanded }: { expanded: boolean }) {
  const agents = useQuery(agentsQuery);
  const waiting = useWaitingHobs();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const open = openHobOf(pathname);

  return (
    <>
      <div aria-hidden className="mx-1.5 my-2 h-px flex-none bg-line" />
      <Link
        to="/hobs"
        aria-label={copy.allHobs}
        className="lbl hidden flex-none self-start rounded-control px-3 pb-1 text-label no-underline hover:text-text-strong group-data-[open=true]/side:block"
      >
        {copy.hobs}
      </Link>
      {agents.isError && <p className="sidebar-label px-3 text-detail text-rose">{copy.hobsLoadFailed}</p>}
      {agents.data?.map((hob) => (
        <SidebarHob
          key={hob.id}
          hob={hob}
          expanded={expanded}
          open={hob.id === open}
          waiting={waiting.has(hob.id)}
          pathname={pathname}
        />
      ))}
      <SidebarTip label={copy.summonLabel} expanded={expanded}>
        <Link to="/summon" className={cn(sidebarItem, "text-lantern hover:text-lantern")}>
          <span aria-hidden className={cn(sidebarIcon, "text-xl leading-none")}>
            +
          </span>
          <span className="sidebar-label flex-1">{copy.summonLabel}</span>
        </Link>
      </SidebarTip>
    </>
  );
}

function SidebarHob({
  hob,
  expanded,
  open,
  waiting,
  pathname,
}: {
  hob: Agent;
  expanded: boolean;
  open: boolean;
  waiting: boolean;
  pathname: string;
}) {
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const full = withRequests(hobState(hob, threads.data, activity), waiting);
  const state = sidebarState(full);
  const word = copy.state[state];
  const mark = MARK[state];
  const showThreads = expanded && open;
  const [cardOpen, setCardOpen] = useCardOpen();

  return (
    <div className="flex flex-none flex-col">
      <Popover open={cardOpen} onOpenChange={setCardOpen}>
        <SidebarTip label={copy.hobTip({ name: hob.name, state: word })} expanded={expanded}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={copy.hob({ name: hob.name, state: word })}
              aria-current={pathname === `/hobs/${hob.id}` ? "page" : undefined}
              className={cn(sidebarItem, "cursor-pointer")}
            >
              <span className={sidebarIcon}>
                <span className="relative inline-flex size-hob-tile items-center justify-center rounded-tile bg-tile">
                  <HobSprite hob={hob} size={28} />
                  {mark && (
                    <span
                      aria-hidden
                      className={cn("absolute -end-[3px] -bottom-[3px] size-3 rounded-dot border-2 border-panel", mark)}
                    />
                  )}
                </span>
              </span>
              <span className="sidebar-label flex min-w-0 flex-1 flex-col">
                <span className="truncate font-heading font-semibold">{hob.name}</span>
                <span className={cn("text-detail", state === "needs-you" ? "text-lantern" : "text-text-secondary")}>
                  {word}
                </span>
              </span>
            </button>
          </PopoverTrigger>
        </SidebarTip>
        <HobCard hob={hob} state={full} threads={threads.data ?? []} />
      </Popover>
      {showThreads && <RecentThreads hobId={hob.id} pathname={pathname} />}
    </div>
  );
}

function RecentThreads({ hobId, pathname }: { hobId: AgentId; pathname: string }) {
  const threads = useQuery(threadsQuery(hobId));
  return (
    <>
      {threads.data?.slice(0, RECENT_THREADS).map((thread) => {
        const current = pathname === `/hobs/${hobId}/threads/${thread.id}`;
        return (
          <Link
            key={thread.id}
            to="/hobs/$hobId/threads/$threadId"
            params={{ hobId, threadId: thread.id }}
            aria-current={current ? "page" : undefined}
            className={cn(
              sidebarItem,
              "animate-hb-in ps-14 pe-2 text-text-secondary hover:text-text-strong aria-[current=page]:text-text-strong",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          </Link>
        );
      })}
    </>
  );
}

/** The card's open state, closed whenever the address changes, so a link inside it never leaves it open over the page. */
const useCardOpen = () => {
  const href = useRouterState({ select: (s) => s.location.href });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (href) setOpen(false);
  }, [href]);
  return [open, setOpen] as const;
};
