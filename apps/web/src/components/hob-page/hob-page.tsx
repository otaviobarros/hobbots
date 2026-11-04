import { type Agent, brainLabel, type Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hobbots/ui/components/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ActivityMap, useActivity } from "../../api/activity.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { hobState, withRequests } from "../../lib/hob-state.ts";
import { formatWhen } from "../../lib/time.ts";
import type { WorkspaceMainProps } from "../archived-threads/archived-threads.tsx";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { HobHero } from "./hob-hero.tsx";
import { doingOf, type HobPageTab, isHobPageTab, statsLine } from "./hob-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * A hob's own page, in the middle of the chat workspace: its hero, then the Chats and History tabs
 * beside a side column. The tab lives in the URL, so a link or Back opens the same one.
 */
export function HobPage({ tab, ...props }: WorkspaceMainProps & { tab: HobPageTab }) {
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
        <Page hob={hob.data} tab={tab} />
      ) : (
        <p role={hob.isPending ? "status" : "alert"} className="m-auto text-text-secondary">
          {hob.isPending ? copy.loading : copy.missing}
        </p>
      )}
    </main>
  );
}

function Page({ hob, tab }: { hob: Agent; tab: HobPageTab }) {
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const waiting = useWaitingHobs().has(hob.id);
  const navigate = useNavigate();
  const list = threads.data ?? [];
  const state = withRequests(hobState(hob, list, activity), waiting);

  const pick = (next: string) => {
    if (!isHobPageTab(next)) return;
    void navigate({
      to: "/hobs/$hobId",
      params: { hobId: hob.id },
      search: next === "chats" ? {} : { tab: next },
      replace: true,
    });
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
            <ChatList hob={hob} threads={list} activity={activity} />
          </TabsContent>
          <TabsContent value="history">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{copy.history.soon}</EmptyTitle>
                <EmptyDescription>{copy.history.soonBody({ name: hob.name })}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </TabsContent>
        </Tabs>
        <aside aria-label={copy.aside.label({ name: hob.name })} className="flex min-w-0 flex-col gap-3">
          <section className="cut flex flex-col gap-2 bg-card p-4">
            <h2 className="lbl m-0 text-label">{copy.aside.thinksWith}</h2>
            <span className="text-sm">{brainLabel(hob.runtime, hob.model)}</span>
            <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} className="text-[13px] text-link underline">
              {copy.aside.change}
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** The hob's chats, newest first, each opening its chat. */
function ChatList({ hob, threads, activity }: { hob: Agent; threads: ReadonlyArray<Thread>; activity: ActivityMap }) {
  if (threads.length === 0) return <p className="m-0 text-sm text-text-secondary">{copy.chats.none}</p>;
  return (
    <ul className="cut m-0 flex list-none flex-col bg-card p-0">
      {threads.map((thread) => (
        <li key={thread.id} className="border-b border-line last:border-b-0">
          <Link
            to="/hobs/$hobId/threads/$threadId"
            params={{ hobId: hob.id, threadId: thread.id }}
            aria-label={copy.chats.open({ title: thread.title })}
            className="flex items-center gap-3 px-4 py-3 text-text-strong no-underline hover:bg-hover hover:text-text-strong"
          >
            {activity[thread.id] && (
              <span
                role="img"
                aria-label={copy.chats.working}
                className="size-2 flex-none animate-hb-blink rounded-(--corner-dot) bg-mint"
              />
            )}
            <span title={thread.title} className="min-w-0 flex-1 truncate font-semibold">
              {thread.title}
            </span>
            <span className="text-xs whitespace-nowrap text-label">{formatWhen(thread.updatedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
