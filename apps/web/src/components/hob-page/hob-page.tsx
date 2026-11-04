import type { Agent, HistoryFilter } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useActivity } from "../../api/activity.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { hobState, withRequests } from "../../lib/hob-state.ts";
import { ArchiveToastViewport } from "../archive/archive-toast.tsx";
import type { WorkspaceMainProps } from "../archived-threads/archived-threads.tsx";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { HobAside } from "./hob-aside.tsx";
import { HobChats } from "./hob-chats.tsx";
import { HobHero } from "./hob-hero.tsx";
import { HobHistory } from "./hob-history.tsx";
import { doingOf, type HobPageTab, isHobPageTab, statsLine } from "./hob-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * A hob's own page, in the middle of the chat workspace: its hero, then the Chats and History tabs
 * beside a side column. The tab lives in the URL, so a link or Back opens the same one.
 */
export function HobPage({ tab, show, ...props }: WorkspaceMainProps & { tab: HobPageTab; show: HistoryFilter }) {
  const hob = useQuery({ ...agentsQuery, select: (hobs) => hobs.find((h) => h.id === props.hobId) });

  return (
    <main
      aria-label={hob.data ? copy.page({ name: hob.data.name }) : undefined}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      {!props.navOpen && (
        <div className="px-4 pt-3">
          <Button variant="icon" size="icon" onClick={props.onShowNav} aria-label={copy.showNav} title={copy.showNav}>
            »
          </Button>
        </div>
      )}
      {hob.data ? (
        <Page hob={hob.data} tab={tab} show={show} />
      ) : (
        <p role={hob.isPending ? "status" : "alert"} className="m-auto text-text-secondary">
          {hob.isPending ? copy.loading : copy.missing}
        </p>
      )}
      {/* The archive toast with Undo stays in sight at the bottom while the page scrolls. */}
      <div className="sticky bottom-6 z-10 mx-auto mt-auto w-full max-w-[520px] empty:hidden">
        <ArchiveToastViewport />
      </div>
    </main>
  );
}

function Page({ hob, tab, show }: { hob: Agent; tab: HobPageTab; show: HistoryFilter }) {
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const waiting = useWaitingHobs().has(hob.id);
  const navigate = useNavigate();
  const list = threads.data ?? [];
  const state = withRequests(hobState(hob, list, activity), waiting);

  // The tab and the History filter live in the URL; Chats and Everything are the defaults and stay out of it.
  const go = (next: HobPageTab, filter: HistoryFilter = "all") =>
    void navigate({
      to: "/hobs/$hobId",
      params: { hobId: hob.id },
      search: next === "chats" ? {} : { tab: next, ...(filter === "all" ? {} : { show: filter }) },
      replace: true,
    });
  const pick = (next: string) => {
    if (isHobPageTab(next)) go(next);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-6 pt-5 pb-12">
      <nav
        aria-label={copy.crumbs}
        className="-mb-2 flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-label"
      >
        <Link
          to="/hobs"
          className="rounded-control px-1 py-0.5 text-text-secondary no-underline hover:bg-hover hover:text-text-strong"
        >
          {copy.yourHobs}
        </Link>
        <span aria-hidden className="opacity-60">
          /
        </span>
        <span aria-current="page" title={hob.name} className="truncate text-text-strong">
          {hob.name}
        </span>
      </nav>
      <HobHero hob={hob} state={state} stats={statsLine(hob, list.length)} doing={doingOf(state, list, activity)} />
      <div className="grid items-start gap-7 min-[1120px]:grid-cols-[minmax(0,1fr)_300px]">
        <Tabs value={tab} onValueChange={pick} className="min-w-0 gap-4">
          <TabsList aria-label={copy.tabs.label({ name: hob.name })}>
            <TabsTrigger value="chats">
              {copy.tabs.chats}
              <span className="rounded-full bg-line px-[7px] py-px text-xs font-semibold text-text-secondary">
                {list.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="history">{copy.tabs.history}</TabsTrigger>
          </TabsList>
          <TabsContent value="chats">
            {list.length === 0 ? (
              <p className="m-0 text-sm text-text-secondary">{copy.chats.none}</p>
            ) : (
              <HobChats hob={hob} threads={list} activity={activity} />
            )}
          </TabsContent>
          <TabsContent value="history">
            <HobHistory hob={hob} filter={show} onFilter={(next) => go("history", next)} />
          </TabsContent>
        </Tabs>
        <HobAside hob={hob} />
      </div>
    </div>
  );
}
