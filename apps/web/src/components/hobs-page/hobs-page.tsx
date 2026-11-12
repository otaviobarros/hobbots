import type { Agent, Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hobbots/ui/components/empty";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { SearchField } from "@hobbots/ui/components/search-field";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type ActivityMap, useHobPresence, useThreadReplies } from "../../api/hub-status.ts";
import { agentsQuery, archivedAgentsQuery, threadsQuery } from "../../api/queries.ts";
import { matchesHob } from "../../lib/crew.ts";
import { type HobState, presenceState } from "../../lib/hob-state.ts";
import { HubWait, ROW_WIDTHS, SKELETON_ROWS } from "../loading/hub-wait.tsx";
import { HobCard, HobCardSkeleton } from "./hob-card.tsx";
import { filterCounts, type HobFilter, isHobFilter, shownCrew } from "./hobs-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

const FILTERS: ReadonlyArray<HobFilter> = ["all", "needs", "working", "resting"];

/**
 * Your hobs: every hob as a card, with filters by state and a search by name or role. A card opens
 * the hob's page. The filter lives in the URL, so a link or Back shows the same hobs.
 */
export function HobsPage({ filter }: { filter: HobFilter }) {
  const agents = useQuery(agentsQuery);
  const [query, setQuery] = useState("");

  return (
    <main aria-label={copy.title} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-page-max flex-col gap-6 px-6 pt-5 pb-12">
        {agents.isError ? (
          <p role="alert" className="m-0 text-ui text-text-secondary">
            {copy.loadFailed}
          </p>
        ) : (
          <Crew
            hobs={agents.data}
            filter={filter}
            query={query}
            onQuery={setQuery}
            onRetry={() => void agents.refetch()}
          />
        )}
        <RetiredLink />
      </div>
    </main>
  );
}

/**
 * The header, the filters and the grid. Until the hobs are read (`hobs` undefined) the header and
 * the filters stand in place with skeleton counts, and the grid holds three skeleton cards.
 */
function Crew({
  hobs,
  filter,
  query,
  onQuery,
  onRetry,
}: {
  hobs: ReadonlyArray<Agent> | undefined;
  filter: HobFilter;
  query: string;
  onQuery: (query: string) => void;
  onRetry: () => void;
}) {
  const reading = hobs === undefined;
  const threadLists = useQueries({ queries: (hobs ?? []).map((hob) => threadsQuery(hob.id)) });
  const activity = useThreadReplies();
  const presence = useHobPresence();
  const navigate = useNavigate();

  const crew = (hobs ?? []).map((hob, index) => {
    const threads = threadLists[index]?.data ?? [];
    return { hob, threads, state: presenceState(presence[hob.id], hob.status) };
  });
  const counts = filterCounts(crew);
  const finding = query.trim() !== "";
  const shown = shownCrew(crew, filter).filter(({ hob }) => matchesHob(hob, query));

  const pick = (next: string) => {
    if (!isHobFilter(next)) return;
    void navigate({ to: "/hobs", search: next === "all" ? {} : { show: next }, replace: true });
  };

  return (
    <>
      <header className="flex flex-wrap items-end gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="m-0 font-heading text-display font-(--heading-weight)">{copy.title}</h1>
          <span className="text-text-secondary">
            {reading ? (
              <Skeleton width="30ch" className="max-w-full" />
            ) : (
              copy.summary({ needs: counts.needs, working: counts.working, resting: counts.resting })
            )}
          </span>
        </span>
        <SearchField
          value={query}
          onValueChange={onQuery}
          clearLabel={copy.find.clear}
          aria-label={copy.find.label}
          placeholder={copy.find.placeholder}
          className="w-[260px] max-w-full"
        />
        <Button asChild>
          <Link to="/summon" className="no-underline">
            <span aria-hidden>+</span>
            {copy.summon}
          </Link>
        </Button>
      </header>
      <FilterChips value={filter} onValueChange={pick} aria-label={copy.filters.label}>
        {FILTERS.map((id) => (
          <FilterChip key={id} value={id} count={reading ? <Skeleton surface="card" width="1ch" /> : counts[id]}>
            {copy.filters[id]}
          </FilterChip>
        ))}
      </FilterChips>
      {reading ? (
        <CrewSkeleton onRetry={onRetry} />
      ) : (
        <Shown shown={shown} activity={activity} filter={filter} finding={finding} />
      )}
    </>
  );
}

/** Three skeleton cards while the hobs are read, and Try again after 10 seconds. */
function CrewSkeleton({ onRetry }: { onRetry: () => void }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <div aria-hidden className="grid grid-cols-2 gap-3.5 min-[1120px]:grid-cols-3">
        {SKELETON_ROWS.map((row) => (
          <HobCardSkeleton key={row} name={ROW_WIDTHS[row]} />
        ))}
      </div>
      <HubWait pending onRetry={onRetry} />
    </div>
  );
}

/** The hobs the filter and the search leave, as cards, or why there are none. */
function Shown({
  shown,
  activity,
  filter,
  finding,
}: {
  shown: ReadonlyArray<{ readonly hob: Agent; readonly threads: ReadonlyArray<Thread>; readonly state: HobState }>;
  activity: ActivityMap;
  filter: HobFilter;
  finding: boolean;
}) {
  return (
    <>
      {(shown.length > 0 || (filter === "all" && !finding)) && (
        <div className="grid grid-cols-2 gap-3.5 min-[1120px]:grid-cols-3">
          {shown.map(({ hob, state, threads }) => (
            <HobCard key={hob.id} hob={hob} state={state} threads={threads} activity={activity} />
          ))}
          {filter === "all" && !finding && <SummonCard />}
        </div>
      )}
      {shown.length === 0 && (finding || filter !== "all") && (
        <Empty surface="card">
          <EmptyHeader>
            <EmptyTitle>{finding || filter === "all" ? copy.none.found : copy.none[filter]}</EmptyTitle>
            {finding && <EmptyDescription>{copy.none.foundHint}</EmptyDescription>}
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

/** The dashed card that closes the grid. */
function SummonCard() {
  return (
    <Link
      to="/summon"
      className="cut flex min-h-[220px] flex-col items-center justify-center gap-2.5 border-[1.5px] border-dashed border-line-2 px-4 text-center text-text-secondary no-underline transition-colors duration-(--dur-fade) hover:border-lantern hover:text-text-strong focus-ring"
    >
      <span
        aria-hidden
        className="grid size-11 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-lantern)_18%,transparent)] text-2xl leading-6 text-lantern"
      >
        +
      </span>
      <strong className="text-text-strong">{copy.summon}</strong>
      <span className="max-w-[200px] text-detail leading-[18px] text-label">{copy.summonCard}</span>
    </Link>
  );
}

/** Retired hobs sit in the Archive; the link says how many. */
function RetiredLink() {
  const retired = useQuery(archivedAgentsQuery);
  return (
    <Link
      to="/archive"
      search={{ tab: "hobs" }}
      className="inline-flex items-center gap-2 self-start rounded-control px-2 py-1.5 text-ui text-text-secondary no-underline hover:bg-hover hover:text-text-strong"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-4"
      >
        <path d="M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z" />
      </svg>
      {retired.data === undefined ? (
        <span className="flex items-center gap-1">
          {copy.retiredLabel}
          <Skeleton width="2ch" />
        </span>
      ) : (
        copy.retired({ count: retired.data.length })
      )}
      <span aria-hidden>→</span>
    </Link>
  );
}
