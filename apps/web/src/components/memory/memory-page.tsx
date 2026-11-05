import type { MemoryChange } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SearchField } from "@hobbots/ui/components/search-field";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { memoryPageGone } from "../../api/memory-pages.ts";
import { memoryCheckQuery, memorySharesQuery } from "../../api/memory-shares.ts";
import { PageHeader } from "../shell/pages.tsx";
import { MemoryChangesView } from "./memory-changes.tsx";
import {
  headLine,
  type MemorySearch,
  type MemoryView,
  memorySearchOf,
  memoryTotals,
  memoryViewOf,
  recentlyLearned,
  scopeNav,
} from "./memory-model.ts";
import { MemoryNav } from "./memory-nav.tsx";
import { MemoryNothingYet, MemoryOverviewSkeleton, MemoryOverviewView } from "./memory-overview.tsx";
import { MemoryIcon, ReadFailed } from "./memory-parts.tsx";
import { MemoryRead } from "./memory-read.tsx";
import { MemoryResults } from "./memory-results.tsx";
import { CheckNow, MemoryReviewView } from "./memory-review.tsx";
import { MemoryScopeView } from "./memory-scope.tsx";
import { messages } from "./messages.ts";
import { reviewItems } from "./review-model.ts";
import { useMemory } from "./use-memory.ts";

const copy = messages;

type Reads = ReturnType<typeof useMemory>;

/** The search in the header. Enter searches; clearing it leaves a search for the overview. */
function MemorySearchForm({ view }: { view: MemoryView }) {
  const navigate = useNavigate();
  const asked = view._tag === "Search" ? view.q : "";
  const [draft, setDraft] = useState(asked);
  const [shownFor, setShownFor] = useState(asked);
  // A search opened from elsewhere, such as Back, shows its own words.
  if (shownFor !== asked) {
    setShownFor(asked);
    setDraft(asked);
  }
  return (
    <search aria-label={copy.search.label} className="w-[300px] max-[1180px]:w-[220px]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const q = draft.trim();
          void navigate({ to: "/memory", search: q === "" ? {} : memorySearchOf({ _tag: "Search", q, within: null }) });
        }}
      >
        <SearchField
          aria-label={copy.search.label}
          placeholder={copy.search.placeholder}
          clearLabel={copy.search.clear}
          value={draft}
          onValueChange={(next) => {
            setDraft(next);
            if (next === "" && view._tag === "Search") void navigate({ to: "/memory", search: {} });
          }}
        />
      </form>
    </search>
  );
}

/** Memory not answering: the page keeps what it last loaded, and says so. */
function NotAnswering({ reads }: { reads: Reads }) {
  const loadedAt = reads.overview.dataUpdatedAt;
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-card bg-notice px-4 py-3">
      <span className="text-text-secondary">
        <MemoryIcon name="notice" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-semibold text-text-strong">{copy.offline.title}</b>
        <span className="text-detail text-text-secondary">
          {copy.offline.body}
          {loadedAt > 0 && ` ${copy.offline.asOf({ at: new Date(loadedAt).toISOString() })}`}
        </span>
      </span>
      <Button variant="outline" size="sm" onClick={reads.retry} disabled={reads.retrying}>
        {reads.retrying ? copy.offline.retrying : copy.offline.retry}
      </Button>
      <Link to="/settings/$section" params={{ section: "data" }} className="text-detail whitespace-nowrap text-link">
        {copy.offline.details}
      </Link>
    </div>
  );
}

/** A read that failed while memory still answers, which the view says in place of its content. */
const failedAlone = (read: { readonly isError: boolean; readonly data: unknown }, offline: boolean) =>
  read.isError && read.data === undefined && !offline;

function OverviewBody({ reads, now }: { reads: Reads; now: Date }) {
  const { overview, changes, pages, hobs, offline } = reads;
  if (overview.data === undefined) {
    if (offline) return null;
    if (overview.isError) return <ReadFailed message={copy.scope.loadFailed} onRetry={reads.retry} />;
    return <MemoryOverviewSkeleton />;
  }
  if (memoryTotals(overview.data).pages === 0) return <MemoryNothingYet />;
  return (
    <MemoryOverviewView learned={recentlyLearned(changes.data ?? [], now)} about={pages.data} hobs={hobs} now={now} />
  );
}

function PageBody({ view, reads, now }: { view: Extract<MemoryView, { _tag: "Page" }>; reads: Reads; now: Date }) {
  const { page, hobs, offline } = reads;
  if (page.data !== undefined) return <MemoryRead read={page.data} version={view.version} hobs={hobs} now={now} />;
  if (memoryPageGone(page.error)) return <PageGone view={view} />;
  if (page.isError && !offline) return <ReadFailed message={copy.page.loadFailed} onRetry={reads.retry} />;
  return offline ? null : <MemoryOverviewSkeleton />;
}

/** What hobs ask to share and what Check now found, which To review lists. */
const useReview = () => {
  const shares = useQuery(memorySharesQuery);
  const check = useQuery(memoryCheckQuery);
  return { shares, check, count: reviewItems(shares.data ?? [], check.data).length };
};
type Review = ReturnType<typeof useReview>;

/** The open view, from what its reads hold so far. */
function ViewBody({ view, reads, review, now }: { view: MemoryView; reads: Reads; review: Review; now: Date }) {
  const { overview, changes, pages, search, hobs, offline } = reads;
  switch (view._tag) {
    case "Review":
      if (review.shares.isError) {
        return <ReadFailed message={copy.review.loadFailed} onRetry={() => void review.shares.refetch()} />;
      }
      return (
        <MemoryReviewView item={view.item} shares={review.shares.data} check={review.check.data} hobs={hobs} now={now} />
      );
    case "Overview":
      return <OverviewBody reads={reads} now={now} />;
    case "Changes":
      if (failedAlone(changes, offline)) return <ReadFailed message={copy.changes.loadFailed} onRetry={reads.retry} />;
      return (
        <MemoryChangesView
          changes={changes.data}
          shares={review.shares.data ?? []}
          show={view.show}
          hobs={hobs}
          now={now}
        />
      );
    case "Scope":
      if (failedAlone(pages, offline)) return <ReadFailed message={copy.scope.loadFailed} onRetry={reads.retry} />;
      return <MemoryScopeView scope={view.scope} kind={view.kind} pages={pages.data} hobs={hobs} />;
    case "Page":
      return <PageBody view={view} reads={reads} now={now} />;
    case "Search":
      if (failedAlone(search, offline)) return <ReadFailed message={copy.results.loadFailed} onRetry={reads.retry} />;
      return (
        <MemoryResults
          q={view.q}
          within={view.within}
          hits={search.data}
          nav={scopeNav(overview.data, reads.active, hobs)}
          hobs={hobs}
        />
      );
  }
}

function PageGone({ view }: { view: Extract<MemoryView, { _tag: "Page" }> }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <h2 className="m-0 font-heading text-heading font-bold text-text-strong">{copy.page.gone}</h2>
      <p className="m-0 text-text-secondary">{copy.page.goneHint}</p>
      <Link
        to="/memory"
        search={memorySearchOf({ _tag: "Scope", scope: view.scope, kind: null })}
        className="text-link"
      >
        {copy.nav.overview}
      </Link>
    </div>
  );
}

/** How many changes arrived since What changed was last open. */
const useNewChanges = (view: MemoryView, changes: ReadonlyArray<MemoryChange> | undefined) => {
  const latest = changes?.[0]?.at ?? "";
  const [seen, setSeen] = useState<string | null>(null);
  // Whatever was there when the page opened, or while What changed is open, counts as seen.
  if (changes !== undefined && (seen === null || (view._tag === "Changes" && latest > seen))) setSeen(latest);
  return seen === null ? 0 : (changes ?? []).filter((change) => change.at > seen).length;
};

/**
 * The Memory page: what every hob remembers, About you and each project, read through the hub.
 * Its views live in the address (STD-REACT-002): the overview, What changed, To review, a scope, a
 * page with its history, and a search. While memory does not answer it shows the pages it last loaded under
 * a notice, and tries again every 30 seconds.
 */
export function MemoryPage({ search }: { search: MemorySearch }) {
  const view = memoryViewOf(search);
  const reads = useMemory(view);
  const now = new Date();
  const nav = scopeNav(reads.overview.data, reads.active, reads.hobs);
  const newChanges = useNewChanges(view, reads.changes.data);
  const review = useReview();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        size="bar"
        icon="Memory"
        title={copy.title}
        intro={headLine(reads.active.length, reads.overview.data, { offline: reads.offline })}
        introClassName={reads.offline ? "text-rose" : undefined}
        actions={
          <div className="flex items-center gap-3">
            <CheckNow />
            <MemorySearchForm view={view} />
          </div>
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <MemoryNav
          nav={nav}
          view={view}
          loading={reads.overview.isPending}
          newChanges={newChanges}
          toReview={review.count}
        />
        <main aria-label={copy.title} className="min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-8 max-[1180px]:px-6">
          {reads.offline && <NotAnswering reads={reads} />}
          <ViewBody view={view} reads={reads} review={review} now={now} />
        </main>
      </div>
    </div>
  );
}
