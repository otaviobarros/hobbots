import { Link } from "@tanstack/react-router";
import { memoryPageGone } from "../../api/memory-pages.ts";
import type { Say } from "./memory-actions.tsx";
import { MemoryChangesView } from "./memory-changes.tsx";
import { MemoryEditor } from "./memory-editor.tsx";
import { HouseRuleForm } from "./memory-house-rule.tsx";
import { type MemoryView, memorySearchOf, memoryTotals, recentlyLearned, scopeNav } from "./memory-model.ts";
import { MemoryNothingYet, MemoryOverviewSkeleton, MemoryOverviewView } from "./memory-overview.tsx";
import { ReadFailed } from "./memory-parts.tsx";
import { MemoryRead } from "./memory-read.tsx";
import { MemoryResults } from "./memory-results.tsx";
import { MemoryScopeView } from "./memory-scope.tsx";
import { messages } from "./messages.ts";
import type { useMemory } from "./use-memory.ts";
import type { MemoryWrites } from "./use-memory-writes.ts";

const copy = messages;

type Reads = ReturnType<typeof useMemory>;

/** What a view needs to change memory: the writes, and the line each says when it is done. */
interface Changes {
  readonly writes: MemoryWrites;
  readonly say: Say;
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

/** The open page, read or in the editor, from what its read holds so far. */
function PageBody({
  view,
  reads,
  now,
  act,
}: {
  view: Extract<MemoryView, { _tag: "Page" | "Edit" }>;
  reads: Reads;
  now: Date;
  act: Changes;
}) {
  const { page, hobs, offline } = reads;
  if (page.data !== undefined) {
    return view._tag === "Edit" ? (
      <MemoryEditor key={view.path} scope={view.scope} read={page.data} kind={null} hobs={hobs} {...act} />
    ) : (
      <MemoryRead read={page.data} version={view.version} hobs={hobs} now={now} {...act} />
    );
  }
  if (memoryPageGone(page.error)) return <PageGone view={view} />;
  if (page.isError && !offline) return <ReadFailed message={copy.page.loadFailed} onRetry={reads.retry} />;
  return offline ? null : <MemoryOverviewSkeleton />;
}

/** The open view, from what its reads hold so far. */
export function ViewBody({ view, reads, now, act }: { view: MemoryView; reads: Reads; now: Date; act: Changes }) {
  const { overview, changes, pages, search, hobs, offline } = reads;
  switch (view._tag) {
    case "Overview":
      return <OverviewBody reads={reads} now={now} />;
    case "Changes":
      if (failedAlone(changes, offline)) return <ReadFailed message={copy.changes.loadFailed} onRetry={reads.retry} />;
      return <MemoryChangesView changes={changes.data} show={view.show} hobs={hobs} now={now} />;
    case "Scope":
      if (failedAlone(pages, offline)) return <ReadFailed message={copy.scope.loadFailed} onRetry={reads.retry} />;
      return (
        <MemoryScopeView scope={view.scope} kind={view.kind} pages={pages.data} hobs={hobs}>
          {view.scope._tag === "Everyone" && <HouseRuleForm {...act} />}
        </MemoryScopeView>
      );
    case "Page":
    case "Edit":
      return <PageBody view={view} reads={reads} now={now} act={act} />;
    case "New":
      return (
        <MemoryEditor key={view.scope._tag} scope={view.scope} read={null} kind={view.kind} hobs={hobs} {...act} />
      );
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

function PageGone({ view }: { view: Extract<MemoryView, { _tag: "Page" | "Edit" }> }) {
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
