import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@hobbots/ui/components/empty";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hobbots/ui/components/menu";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { SearchField } from "@hobbots/ui/components/search-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { agentsQuery, archivedAgentsQuery, archivedThreadsQuery, threadsQuery } from "../../api/queries.ts";
import { useSearch } from "../../api/search.ts";
import { ARCHIVE_CHEST, archiveChestPalette } from "../../art/icons.ts";
import { formatCount } from "../../lib/format.ts";
import { formatDay } from "../../lib/time.ts";
import { isMac } from "../archive/archive-rules.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import {
  type ArchivedChat,
  type ArchiveTab,
  allArchivedChats,
  isArchiveTab,
  type ScopeChip,
  SHOWN,
  scopeChips,
  visibleChats,
} from "./archive-model.ts";
import { useArchiveActions } from "./archive-notices.tsx";
import { ArchiveFrame, Crumbs, DimPortrait, doorStyle, MoonIcon, RestoreIcon, stripStyle } from "./archive-parts.tsx";
import { BringBackButton } from "./archive-read.tsx";
import { messages } from "./messages.ts";
import { useFocusAfterRestore } from "./use-focus-after-restore.ts";

const copy = messages;

const countPill = "rounded-full bg-line px-[7px] py-px text-meta font-semibold text-text-secondary";

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
  const byHob = new Map<AgentId, ReadonlyArray<Thread>>();
  (hobs.data ?? []).forEach((hob, index) => {
    const list = archived.lists[index];
    if (list) byHob.set(hob.id, list);
  });
  const chats = allArchivedChats(hobs.data ?? [], byHob);

  const pick = (next: string) => {
    if (!isArchiveTab(next)) return;
    void navigate({
      to: "/archive",
      search: { ...(next === "hobs" && { tab: "hobs" }), ...(hobId !== undefined && { hob: hobId }) },
      replace: true,
    });
  };

  return (
    <ArchiveFrame label={copy.title}>
      <Crumbs trail={[]} current={copy.title} />
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
            <p role="alert" className="m-0 text-ui text-rose">
              {copy.chats.loadFailed}
            </p>
          ) : hobs.isPending || archived.pending ? (
            <p role="status" className="m-0 text-ui text-label">
              {copy.chats.loading}
            </p>
          ) : (
            <ArchivedChats hobs={hobs.data} chats={chats} hobId={hobId} tab={tab} />
          )}
        </TabsContent>
        <TabsContent value="hobs" className="flex flex-col gap-4">
          <p className="m-0 text-ui text-text-secondary">{copy.hobs.intro}</p>
          {retired.isError ? (
            <p role="alert" className="m-0 text-ui text-rose">
              {copy.hobs.loadFailed}
            </p>
          ) : retired.isPending ? (
            <p role="status" className="m-0 text-ui text-label">
              {copy.hobs.loading}
            </p>
          ) : (
            <RetiredHobs hobs={retired.data} />
          )}
        </TabsContent>
      </Tabs>
    </ArchiveFrame>
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
  const messageHits = new Set<ThreadId>(
    search.hits.filter((hit) => hit.thread.archivedAt !== null).map((hit) => hit.thread.id),
  );
  const scope = scopeChips(hobs, chats, hobId);
  const chosen = hobs.find((hob) => hob.id === hobId);
  const visible = visibleChats(chats, chosen?.id, query, messageHits);
  const trimmed = query.trim();
  const focus = useFocusAfterRestore(visible);

  const pickScope = (next: string) =>
    void navigate({
      to: "/archive",
      search: { ...(tab === "hobs" && { tab: "hobs" }), ...(next !== "all" && { hob: next }) },
      replace: true,
    });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {scope.chips.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <FilterChips aria-label={copy.scope.label} value={chosen?.id ?? "all"} onValueChange={pickScope}>
              <FilterChip value="all" count={chats.length}>
                {copy.scope.all}
              </FilterChip>
              {scope.chips.map(({ hob, count }) => (
                <FilterChip key={hob.id} value={hob.id} count={count} title={hob.name} className="max-w-[220px]">
                  <span className="truncate">{hob.name}</span>
                </FilterChip>
              ))}
            </FilterChips>
            {scope.more.length > 0 && <MoreHobs more={scope.more} onPick={pickScope} />}
          </div>
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
        <ChatList key={`${chosen?.id ?? "all"}|${trimmed}`} chats={visible} focus={focus} />
      ) : (
        <Empty surface="card">
          <EmptyHeader>
            <EmptyMedia>
              <PixelArt rows={ARCHIVE_CHEST} palette={archiveChestPalette} size={72} />
            </EmptyMedia>
            <EmptyTitle asChild>
              <h2 ref={focus.empty}>
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

/** The hobs past the scope's six chips, in a menu; picking one makes it the picked chip. */
function MoreHobs({ more, onPick }: { more: ReadonlyArray<ScopeChip<Agent>>; onPick: (hobId: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8.5 shrink-0 cursor-pointer items-center gap-2 rounded-full border-(length:--edge) border-dashed border-line-2 bg-transparent px-3.5 text-ui whitespace-nowrap text-text-secondary outline-none hover:border-control hover:text-text-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ground">
        {copy.scope.more}
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-text-strong/11 px-1.5 text-meta font-semibold tabular-nums">
          {formatCount(more.length)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[320px] overflow-y-auto">
        {more.map(({ hob, count }) => (
          <DropdownMenuItem key={hob.id} onSelect={() => onPick(hob.id)} className="flex-row items-center gap-3">
            <span className="min-w-0 flex-1 truncate" title={hob.name}>
              {hob.name}
            </span>
            <span className="flex-none text-meta text-label tabular-nums">{formatCount(count)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type RestoreFocus = ReturnType<typeof useFocusAfterRestore>;

function ChatList({ chats, focus }: { chats: ReadonlyArray<ArchivedChat>; focus: RestoreFocus }) {
  const [all, setAll] = useState(false);
  const shown = all ? chats : chats.slice(0, SHOWN);
  return (
    <>
      <ul aria-label={copy.chats.list} className="cut m-0 flex list-none flex-col bg-card p-0">
        {shown.map((chat) => (
          <ChatRow key={chat.thread.id} chat={chat} focus={focus} />
        ))}
      </ul>
      {!all && chats.length > SHOWN && (
        <Button variant="text" size="sm" className="self-start" onClick={() => setAll(true)}>
          {copy.chats.showMore({ count: chats.length - SHOWN })}
        </Button>
      )}
    </>
  );
}

function ChatRow({ chat: { hob, thread }, focus }: { chat: ArchivedChat; focus: RestoreFocus }) {
  const actions = useArchiveActions();
  const busy = actions.busy(thread);
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="relative grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 hover:bg-hover">
        <DimPortrait hob={hob} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <Link
            to="/archive/chats/$hobId/$threadId"
            params={{ hobId: hob.id, threadId: thread.id }}
            aria-label={copy.chats.open({ title: thread.title })}
            title={thread.title}
            className="truncate font-semibold text-text-strong no-underline after:absolute after:inset-0 hover:text-text-strong"
          >
            {thread.title}
          </Link>
          {thread.lastLine && (
            <span title={thread.lastLine} className="truncate text-ui text-text-secondary">
              {thread.lastLine}
            </span>
          )}
          <span className="truncate text-meta text-label">
            {copy.chats.meta({ name: hob.name, day: formatDay(thread.archivedAt ?? thread.updatedAt) })}
          </span>
        </span>
        {/* Never disabled while it restores, so it keeps the focus; its label says Restoring and a press meanwhile does nothing. */}
        <Button
          ref={focus.button(thread.id)}
          variant="outline"
          size="sm"
          className="relative z-[1]"
          aria-disabled={busy}
          aria-label={copy.chats.restoreLabel({ title: thread.title })}
          onClick={() => {
            if (!busy) actions.restore(hob, thread, () => focus.restored(thread.id));
          }}
        >
          <RestoreIcon />
          {/* On a narrow screen the row keeps the icon, so the title has room; the label still names it. */}
          <span className="max-sm:sr-only">{busy ? copy.chats.restoring : copy.chats.restore}</span>
        </Button>
      </div>
    </li>
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
    <ul
      aria-label={copy.hobs.list}
      className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4 p-0"
    >
      {hobs.map((hob) => (
        <RetiredCard key={hob.id} hob={hob} />
      ))}
    </ul>
  );
}

function RetiredCard({ hob }: { hob: Agent }) {
  const threads = useQuery(threadsQuery(hob.id));
  return (
    <li className="cut relative flex min-w-0 flex-col overflow-hidden bg-card">
      <span aria-hidden className="relative flex h-[104px] items-end justify-center" style={doorStyle}>
        <HobSprite hob={hob} size={72} state="asleep" className="mb-2.5 opacity-65 grayscale-85" />
        <span className="absolute inset-x-0 bottom-0 h-2.5" style={stripStyle} />
        <Badge variant="resting" className="absolute top-2.5 end-2.5">
          <MoonIcon />
          {copy.hobs.tag}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-col gap-2 p-4">
        <span className="flex min-w-0 flex-col">
          <Link
            to="/archive/hobs/$hobId"
            params={{ hobId: hob.id }}
            aria-label={copy.hobs.read({ name: hob.name })}
            title={hob.name}
            className="truncate font-(family-name:--font-heading) text-lg leading-6 font-(--heading-weight) text-text-strong no-underline after:absolute after:inset-0 hover:text-text-strong"
          >
            {hob.name}
          </Link>
          <span title={hob.roleTitle} className="truncate text-meta text-label">
            {hob.roleTitle}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <span className="flex min-w-0 flex-col text-ui">
            <span className="truncate">{threads.data ? copy.hobs.kept({ count: threads.data.length }) : " "}</span>
            <span className="truncate text-meta text-label">
              {hob.retiredAt ? copy.hobs.retired({ day: formatDay(hob.retiredAt) }) : copy.hobs.retiredUnknown}
            </span>
          </span>
          <BringBackButton hob={hob} chats={threads.data?.length ?? 0} quiet />
        </span>
      </span>
    </li>
  );
}
