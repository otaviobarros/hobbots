import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useActivity } from "../api/activity.ts";
import { agentsQuery, threadsQuery } from "../api/queries.ts";
import { formatWhen } from "../lib/time.ts";
import { ArchivedEntry } from "./archived-threads/archived-threads.tsx";
import { HobSprite, hobState, stateLabel } from "./hob-sprite.tsx";
import { messages } from "./messages.ts";
import { SearchResults } from "./search-results.tsx";

const copy = messages.hobPanel;

/** Left panel: search, each hob with its threads, Rooms (later) and Summon. A search shows its results instead of the hobs. */
export function HobList({
  hobId,
  threadId,
  onHide,
}: {
  hobId?: AgentId | undefined;
  threadId?: ThreadId | undefined;
  onHide: () => void;
}) {
  const agents = useQuery(agentsQuery);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  return (
    <nav
      aria-label={copy.label}
      className="flex w-64 flex-none flex-col gap-2.5 border-r-4 border-line bg-panel px-2.5 py-3"
    >
      <div className="flex gap-1.5">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.search}
          aria-label={copy.searchLabel}
          className="min-w-0 flex-1 border-2 border-control bg-deep px-[9px] py-[7px] text-sm text-text placeholder:text-label"
        />
        <Button variant="icon" size="icon" onClick={onHide} aria-label={copy.hide} title={copy.hide}>
          «
        </Button>
      </div>

      {searching ? (
        <SearchResults query={query} onOpen={() => setQuery("")} />
      ) : (
        <div className="flex min-h-0 flex-col gap-px overflow-y-auto">
          <span className="lbl px-2 pb-1.5 text-label">{copy.hobs}</span>
          {agents.isPending && <p className="px-2 text-sm text-label">{copy.loading}</p>}
          {agents.isError && <p className="px-2 text-sm text-rose">{copy.loadFailed}</p>}
          {agents.data?.map((hob) => (
            <HobEntry key={hob.id} hob={hob} open={hob.id === hobId} threadId={threadId} />
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex items-center gap-2 border-2 border-dashed border-control px-2.5 py-2">
          <span className="flex-1 font-pixel text-sm font-semibold text-moonlight">{copy.rooms}</span>
          <Badge variant="later">{copy.later}</Badge>
        </div>
        <Button asChild>
          <Link to="/summon">{copy.summon}</Link>
        </Button>
        <span className="text-center text-xs text-label">{copy.keys}</span>
      </div>
    </nav>
  );
}

function HobEntry({ hob, open, threadId }: { hob: Agent; open: boolean; threadId?: ThreadId | undefined }) {
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const state = hobState(hob, threads.data, activity);
  const count = threads.data?.length ?? 0;

  return (
    <div className="flex flex-col">
      <Link
        to="/hobs/$hobId"
        params={{ hobId: hob.id }}
        aria-expanded={open}
        className={cn(
          "hop-on-hover cut flex w-full items-center gap-2.5 px-2 py-[7px] text-text no-underline hover:bg-hover hover:text-text",
          open && "bg-line",
        )}
      >
        <span className="bg-line p-0.5">
          <HobSprite hob={hob} size={28} state={state} badge />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex justify-between gap-1.5">
            <span className="font-pixel text-base font-semibold">{hob.name}</span>
            <span className={cn("text-xs", state === "idle" || state === "paused" ? "text-label" : "text-mint")}>
              {stateLabel[state]}
            </span>
          </span>
          <span className="flex min-w-0 gap-1.5 text-xs text-label">
            <span className="truncate font-bold text-moonlight">{hob.roleTitle}</span>
            <span className="whitespace-nowrap">· {copy.threadCount({ count })}</span>
          </span>
        </span>
      </Link>
      {open && (
        <div className="flex animate-hb-in flex-col pt-0.5 pb-1.5">
          {threads.data?.map((thread) => (
            <ThreadLink
              key={thread.id}
              hobId={hob.id}
              thread={thread}
              current={thread.id === threadId}
              live={!!activity[thread.id]}
            />
          ))}
          <Link
            to="/hobs/$hobId/new"
            params={{ hobId: hob.id }}
            className="flex w-full items-center py-[7px] pr-2.5 pl-[34px] text-sm text-lantern no-underline hover:bg-hover"
          >
            {copy.newThread}
          </Link>
          <ArchivedEntry hobId={hob.id} threadId={threadId} />
        </div>
      )}
    </div>
  );
}

function ThreadLink({
  hobId,
  thread,
  current,
  live,
}: {
  hobId: AgentId;
  thread: Thread;
  current: boolean;
  live: boolean;
}) {
  return (
    <Link
      to="/hobs/$hobId/threads/$threadId"
      params={{ hobId, threadId: thread.id }}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 py-[7px] pr-2.5 pl-[34px] text-sm text-text no-underline hover:bg-hover hover:text-text",
        current && "bg-line text-moonlight hover:text-moonlight",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      {live && <span role="img" aria-label={copy.working} className="size-[7px] flex-none animate-hb-blink bg-mint" />}
      <span className="text-[11px] whitespace-nowrap text-label">{formatWhen(thread.updatedAt)}</span>
    </Link>
  );
}
