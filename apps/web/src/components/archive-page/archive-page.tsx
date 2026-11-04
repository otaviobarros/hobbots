import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@hobbots/ui/components/empty";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { SearchField } from "@hobbots/ui/components/search-field";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useMemo, useState } from "react";
import { useRestoreThread } from "../../api/archived-threads.ts";
import { agentsQuery, archivedAgentsQuery, archivedThreadsQuery, threadsQuery } from "../../api/queries.ts";
import { useSearch } from "../../api/search.ts";
import { ARCHIVE_CHEST, archiveChestPalette } from "../../art/icons.ts";
import { formatDay } from "../../lib/time.ts";
import { isMac } from "../archive/archive-rules.ts";
import { HobSprite } from "../hob-sprite.tsx";
import {
  type ArchivedChat,
  type ArchiveTab,
  allArchivedChats,
  isArchiveTab,
  SHOWN,
  scopeHobs,
  visibleChats,
} from "./archive-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

const countPill = "rounded-full bg-line px-[7px] py-px text-xs font-semibold text-text-secondary";

/**
 * The Archive: archived chats across every hob and retired hobs, on two tabs. The tab and the hob
 * the chats are narrowed to live in the address, so a link or Back opens the same view.
 */
export function ArchivePage({ tab, hobId }: { tab: ArchiveTab; hobId: AgentId | undefined }) {
  const navigate = useNavigate();
  const hobs = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const archived = useQueries({
    queries: (hobs.data ?? []).map((hob) => archivedThreadsQuery(hob.id)),
    combine: (results) => ({
      lists: results.map((result) => result.data),
      pending: results.some((result) => result.isPending),
      error: results.some((result) => result.isError),
    }),
  });
  const chats = useMemo(() => {
    const byHob = new Map<AgentId, ReadonlyArray<Thread>>();
    (hobs.data ?? []).forEach((hob, index) => {
      const list = archived.lists[index];
      if (list) byHob.set(hob.id, list);
    });
    return allArchivedChats(hobs.data ?? [], byHob);
  }, [hobs.data, archived.lists]);

  const pick = (next: string) => {
    if (!isArchiveTab(next)) return;
    void navigate({
      to: "/archive",
      search: { ...(next === "hobs" && { tab: "hobs" }), ...(hobId !== undefined && { hob: hobId }) },
      replace: true,
    });
  };

  return (
    <main aria-label={copy.title} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-5 px-6 pt-5 pb-12">
        <nav aria-label={copy.crumbs} className="flex items-center gap-2 text-sm text-text-secondary">
          <Link to="/hobs" className="text-text-secondary no-underline hover:text-text-strong hover:underline">
            {copy.yourHobs}
          </Link>
          <span aria-hidden className="text-label">
            /
          </span>
          <span aria-current="page" className="text-text-strong">
            {copy.title}
          </span>
        </nav>
        <header className="flex items-center gap-4">
          <span aria-hidden className="grid size-14 flex-none place-items-center rounded-card bg-card">
            <PixelArt rows={ARCHIVE_CHEST} palette={archiveChestPalette} size={36} />
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <h1 className="m-0 font-(family-name:--font-heading) text-[32px] leading-[38px] font-(--heading-weight) [font-variant-ligatures:none]">
              {copy.title}
            </h1>
            <span className="text-text-secondary">{copy.intro}</span>
          </span>
        </header>
        <Tabs value={tab} onValueChange={pick} className="min-w-0 gap-4">
          <TabsList aria-label={copy.tabs.label}>
            <TabsTrigger value="chats">
              {copy.tabs.chats}
              <span className={countPill}>{chats.length}</span>
            </TabsTrigger>
            <TabsTrigger value="hobs">
              {copy.tabs.hobs}
              <span className={countPill}>{retired.data?.length ?? 0}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chats" className="flex flex-col gap-4">
            {hobs.isError || archived.error ? (
              <p role="alert" className="m-0 text-sm text-rose">
                {copy.chats.loadFailed}
              </p>
            ) : hobs.isPending || archived.pending ? (
              <p role="status" className="m-0 text-sm text-label">
                {copy.chats.loading}
              </p>
            ) : (
              <ArchivedChats hobs={hobs.data} chats={chats} hobId={hobId} tab={tab} />
            )}
          </TabsContent>
          <TabsContent value="hobs" className="flex flex-col gap-4">
            <p className="m-0 text-sm text-text-secondary">{copy.hobs.intro}</p>
            {retired.isError ? (
              <p role="alert" className="m-0 text-sm text-rose">
                {copy.hobs.loadFailed}
              </p>
            ) : retired.isPending ? (
              <p role="status" className="m-0 text-sm text-label">
                {copy.hobs.loading}
              </p>
            ) : (
              <RetiredHobs hobs={retired.data} />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

/** The Archived chats tab: the scope, the search and the list, twelve at a time. */
function ArchivedChats({
  hobs,
  chats,
  hobId,
  tab,
}: {
  hobs: ReadonlyArray<Agent>;
  chats: ReadonlyArray<ArchivedChat>;
  hobId: AgentId | undefined;
  tab: ArchiveTab;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const search = useSearch(query);
  const messageHits = useMemo(
    () => new Set<ThreadId>(search.hits.filter((hit) => hit.thread.archivedAt !== null).map((hit) => hit.thread.id)),
    [search.hits],
  );
  const scope = scopeHobs(hobs, chats, hobId);
  const chosen = hobs.find((hob) => hob.id === hobId);
  const visible = visibleChats(chats, chosen?.id, query, messageHits);
  const trimmed = query.trim();

  const pickScope = (next: string) =>
    void navigate({
      to: "/archive",
      search: { ...(tab === "hobs" && { tab: "hobs" }), ...(next !== "all" && { hob: next }) },
      replace: true,
    });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {scope.length > 0 && (
          <SegmentedControl aria-label={copy.scope.label} value={chosen?.id ?? "all"} onValueChange={pickScope}>
            {scope.map((hob) => (
              <SegmentedControlItem key={hob.id} value={hob.id} className="max-w-[180px]">
                <span className="truncate">{hob.name}</span>
              </SegmentedControlItem>
            ))}
            <SegmentedControlItem value="all">{copy.scope.all}</SegmentedControlItem>
          </SegmentedControl>
        )}
        <span className="flex-1" />
        <SearchField
          value={query}
          onValueChange={setQuery}
          clearLabel={copy.search.clear}
          aria-label={copy.search.label}
          placeholder={copy.search.label}
          className="w-[300px] max-w-full"
        />
      </div>
      {visible.length > 0 ? (
        // A new scope or search starts again at twelve.
        <ChatList key={`${chosen?.id ?? "all"}|${trimmed}`} chats={visible} />
      ) : (
        <Empty surface="card">
          <EmptyHeader>
            <EmptyMedia>
              <PixelArt rows={ARCHIVE_CHEST} palette={archiveChestPalette} size={72} />
            </EmptyMedia>
            <EmptyTitle asChild>
              <h2>
                {trimmed !== ""
                  ? copy.chats.noMatch({ query: trimmed })
                  : chats.length === 0
                    ? copy.chats.none
                    : chosen
                      ? copy.chats.noneFor({ name: chosen.name })
                      : copy.chats.noneAll}
              </h2>
            </EmptyTitle>
            <EmptyDescription>{copy.chats.howTo({ mac: isMac() })}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

function ChatList({ chats }: { chats: ReadonlyArray<ArchivedChat> }) {
  const [all, setAll] = useState(false);
  const shown = all ? chats : chats.slice(0, SHOWN);
  return (
    <>
      <ul aria-label={copy.chats.list} className="cut m-0 flex list-none flex-col bg-card p-0">
        {shown.map((chat) => (
          <ChatRow key={chat.thread.id} chat={chat} />
        ))}
      </ul>
      {!all && chats.length > SHOWN && (
        <Button variant="link" size="sm" className="self-start" onClick={() => setAll(true)}>
          {copy.chats.showMore({ count: chats.length - SHOWN })}
        </Button>
      )}
    </>
  );
}

function ChatRow({ chat: { hob, thread } }: { chat: ArchivedChat }) {
  const restore = useRestoreThread();
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="relative grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 hover:bg-hover">
        <DimPortrait hob={hob} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <Link
            to="/hobs/$hobId/threads/$threadId"
            params={{ hobId: hob.id, threadId: thread.id }}
            aria-label={copy.chats.open({ title: thread.title })}
            title={thread.title}
            className="truncate font-semibold text-text-strong no-underline after:absolute after:inset-0 hover:text-text-strong"
          >
            {thread.title}
          </Link>
          <span className="truncate text-xs text-label">
            {copy.chats.meta({ name: hob.name, day: formatDay(thread.archivedAt ?? thread.updatedAt) })}
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="relative z-[1]"
          disabled={restore.isPending}
          aria-label={copy.chats.restoreLabel({ title: thread.title })}
          onClick={() => restore.mutate(thread.id)}
        >
          <RestoreIcon />
          {restore.isPending ? copy.chats.restoring : copy.chats.restore}
        </Button>
      </div>
      {restore.isError && (
        <div role="alert" className="flex items-center gap-3 px-3.5 pb-3 text-sm text-rose">
          <span className="flex-1">{copy.chats.restoreFailed({ title: thread.title })}</span>
          <Button variant="outline" size="xs" onClick={() => restore.mutate(thread.id)}>
            {copy.chats.tryAgain}
          </Button>
        </div>
      )}
    </li>
  );
}

/** A hob's portrait on a sunken tile, grayed: it is not where the hob is working now. */
function DimPortrait({ hob }: { hob: Agent }) {
  return (
    <span aria-hidden className="grid size-9 place-items-center rounded-control bg-deep">
      <HobSprite hob={hob} size={28} className="opacity-60 grayscale-80" />
    </span>
  );
}

/** The arrow that turns back, on Restore and Bring back. */
function RestoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 3 2.5 5.5 5 8" />
      <path d="M2.5 5.5H10a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

/** The Retired hobs tab: a card for each retired hob, most recently retired first. */
function RetiredHobs({ hobs }: { hobs: ReadonlyArray<Agent> }) {
  if (hobs.length === 0) {
    return (
      <Empty surface="card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MoonIcon />
          </EmptyMedia>
          <EmptyTitle asChild>
            <h2>{copy.hobs.none}</h2>
          </EmptyTitle>
          <EmptyDescription>{copy.hobs.noneBody}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul aria-label={copy.hobs.list} className="m-0 grid list-none grid-cols-2 gap-4 p-0 min-[1120px]:grid-cols-3">
      {hobs.map((hob) => (
        <RetiredCard key={hob.id} hob={hob} />
      ))}
    </ul>
  );
}

// Retired hobs go gray: the door takes the control color where an active hob takes its hat color.
const doorStyle = {
  "--hob": "var(--color-control)",
  backgroundImage:
    "linear-gradient(180deg, color-mix(in srgb, var(--hob) 26%, var(--color-card)) 0%, var(--color-card) 100%)",
} as CSSProperties;

const stripStyle: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(90deg, color-mix(in srgb, var(--hob) 50%, var(--color-deep)) 0 8px, color-mix(in srgb, var(--hob) 35%, var(--color-deep)) 8px 16px)",
};

function RetiredCard({ hob }: { hob: Agent }) {
  const threads = useQuery(threadsQuery(hob.id));
  return (
    <li className="cut relative flex min-w-0 flex-col overflow-hidden bg-card">
      <span aria-hidden className="relative flex h-[104px] items-end justify-center" style={doorStyle}>
        <HobSprite hob={hob} size={72} state="asleep" className="mb-2.5 opacity-65 grayscale-85" />
        <span className="absolute inset-x-0 bottom-0 h-2.5" style={stripStyle} />
        <Badge variant="resting" className="absolute top-2.5 right-2.5">
          <MoonIcon />
          {copy.hobs.tag}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-col gap-2 p-4">
        <span className="flex min-w-0 flex-col">
          <Link
            to="/settings/archived/$hobId"
            params={{ hobId: hob.id }}
            aria-label={copy.hobs.read({ name: hob.name })}
            title={hob.name}
            className="truncate font-(family-name:--font-heading) text-lg leading-6 font-(--heading-weight) text-text-strong no-underline after:absolute after:inset-0 hover:text-text-strong"
          >
            {hob.name}
          </Link>
          <span title={hob.roleTitle} className="truncate text-xs text-label">
            {hob.roleTitle}
          </span>
        </span>
        <span className="flex min-w-0 flex-col text-sm">
          <span className="truncate">{threads.data ? copy.hobs.kept({ count: threads.data.length }) : " "}</span>
          <span className="truncate text-xs text-label">
            {hob.retiredAt ? copy.hobs.retired({ day: formatDay(hob.retiredAt) }) : copy.hobs.retiredUnknown}
          </span>
        </span>
      </span>
    </li>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z" />
    </svg>
  );
}
