import type { Agent, HistoryFilter } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useActivity } from "../../api/activity.ts";
import { useIsNewHob } from "../../api/history.ts";
import { hobMemoryScopesQuery } from "../../api/memory-saves.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { hobState, withRequests } from "../../lib/hob-state.ts";
import { ArchiveToastViewport } from "../archive/archive-toast.tsx";
import type { WorkspaceMainProps } from "../archived-threads/archived-threads.tsx";
import { useWaitingHobs } from "../inbox/use-waiting-count.ts";
import { MemoryIcon } from "../memory/memory-parts.tsx";
import { HobAside } from "./hob-aside.tsx";
import { ChatsLoading, HobChats } from "./hob-chats.tsx";
import { HobHero } from "./hob-hero.tsx";
import { HobHistory } from "./hob-history.tsx";
import { HobMemory } from "./hob-memory.tsx";
import { doingOf, type HobPageTab, isHobPageTab, statsLine } from "./hob-page-model.ts";
import { HobCrumbs, HobPageSkeleton } from "./hob-page-skeleton.tsx";
import { ownCount } from "./memory-model.ts";
import { messages } from "./messages.ts";
import { NewHob } from "./new-hob.tsx";
import { useNeedLine } from "./use-need-line.ts";

const copy = messages;

/**
 * A hob's own page, in the middle of the chat workspace: its hero, then the Chats and History tabs
 * beside a side column. The tab lives in the URL, so a link or Back opens the same one.
 */
export function HobPage({
  tab,
  show,
  query,
  ...props
}: WorkspaceMainProps & { tab: HobPageTab; show: HistoryFilter; query: string }) {
  const hob = useQuery({ ...agentsQuery, select: (hobs) => hobs.find((h) => h.id === props.hobId) });

  return (
    <main
      aria-label={hob.data ? copy.page({ name: hob.data.name }) : undefined}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      {hob.data ? (
        <Page hob={hob.data} tab={tab} show={show} query={query} />
      ) : hob.isPending ? (
        <HobPageSkeleton onRetry={() => void hob.refetch()} />
      ) : (
        <p role="alert" className="m-auto text-text-secondary">
          {copy.missing}
        </p>
      )}
      {/* The archive toast with Undo stays in sight at the bottom while the page scrolls. */}
      <div className="sticky bottom-6 z-10 mx-auto mt-auto w-full max-w-[520px] empty:hidden">
        <ArchiveToastViewport />
      </div>
    </main>
  );
}

function Page({ hob, tab, show, query }: { hob: Agent; tab: HobPageTab; show: HistoryFilter; query: string }) {
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const waiting = useWaitingHobs().has(hob.id);
  const need = useNeedLine(hob.id);
  const navigate = useNavigate();
  const list = threads.data ?? [];
  const state = withRequests(hobState(hob, list, activity), waiting);
  const fresh = useIsNewHob(hob.id, threads.isSuccess ? list.length : undefined);

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
    <div className="mx-auto flex w-full max-w-page-max flex-col gap-6 px-6 pt-5 pb-12">
      <HobCrumbs name={hob.name} />
      <HobHero
        hob={hob}
        state={state}
        // The chat count is unknown until the chats are read: never "No chats yet" while asking.
        stats={threads.isPending ? undefined : statsLine(hob, list.length)}
        doing={doingOf(state, list, activity, need)}
        fresh={fresh}
      />
      <div className="grid items-start gap-7 min-[1120px]:grid-cols-[minmax(0,1fr)_300px]">
        <Tabs value={tab} onValueChange={pick} className="min-w-0 gap-4">
          <TabsList aria-label={copy.tabs.label({ name: hob.name })}>
            <TabsTrigger value="chats">
              {copy.tabs.chats}
              <ChatCount count={threads.isPending ? undefined : list.length} />
            </TabsTrigger>
            <TabsTrigger value="history">{copy.tabs.history}</TabsTrigger>
            <TabsTrigger value="memory">
              <MemoryIcon name="book" size={14} />
              {copy.tabs.memory}
              <MemoryCount hob={hob} />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chats">
            {threads.isPending ? (
              <ChatsLoading onRetry={() => void threads.refetch()} />
            ) : list.length === 0 ? (
              <NewHob hob={hob} />
            ) : (
              <HobChats hob={hob} threads={list} activity={activity} initialQuery={query} />
            )}
          </TabsContent>
          <TabsContent value="history">
            <HobHistory hob={hob} filter={show} onFilter={(next) => go("history", next)} />
          </TabsContent>
          <TabsContent value="memory">
            <HobMemory hob={hob} />
          </TabsContent>
        </Tabs>
        <HobAside hob={hob} />
      </div>
    </div>
  );
}

/** The Chats tab's count, a skeleton while the chats are read: never 0 while asking. */
function ChatCount({ count }: { count: number | undefined }) {
  return (
    <span className="rounded-full bg-line px-[7px] py-px text-meta font-semibold text-text-secondary">
      {count ?? <Skeleton surface="card" width="1ch" />}
    </span>
  );
}

/** The Memory tab's count of the hob's own pages, left out while memory does not answer. */
function MemoryCount({ hob }: { hob: Agent }) {
  const scopes = useQuery(hobMemoryScopesQuery(hob.id));
  if (scopes.isError && scopes.data === undefined) return null;
  return <ChatCount count={ownCount(scopes.data?.scopes)} />;
}
