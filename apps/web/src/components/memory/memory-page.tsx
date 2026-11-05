import type { MemoryChange } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SearchField } from "@hobbots/ui/components/search-field";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useShowMemoryFiles } from "../../lib/show-memory-files.ts";
import { PageHeader } from "../shell/pages.tsx";
import type { Say } from "./memory-actions.tsx";
import {
  flashKeyOf,
  headLine,
  type MemorySearch,
  type MemoryView,
  memorySearchOf,
  memoryViewOf,
  scopeNav,
} from "./memory-model.ts";
import { MemoryNav } from "./memory-nav.tsx";
import { FlashLine, MemoryIcon } from "./memory-parts.tsx";
import { CheckNow } from "./memory-review.tsx";
import { useReview, ViewBody } from "./memory-view-body.tsx";
import { messages } from "./messages.ts";
import { reviewItems } from "./review-model.ts";
import { useMemory } from "./use-memory.ts";
import { type MemoryFlash, useMemoryWrites } from "./use-memory-writes.ts";

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

/** How many changes arrived since What changed was last open. */
const useNewChanges = (view: MemoryView, changes: ReadonlyArray<MemoryChange> | undefined) => {
  const latest = changes?.[0]?.at ?? "";
  const [seen, setSeen] = useState<string | null>(null);
  // Whatever was there when the page opened, or while What changed is open, counts as seen.
  if (changes !== undefined && (seen === null || (view._tag === "Changes" && latest > seen))) setSeen(latest);
  return seen === null ? 0 : (changes ?? []).filter((change) => change.at > seen).length;
};

/** Open folder, on the desktop app on the hub: memory's pages as markdown files, in Finder. */
function OpenFolder({ say }: { say: Say }) {
  const { open, state } = useShowMemoryFiles();
  if (open === undefined) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={state === "pending"}
      aria-busy={state === "pending"}
      onClick={() =>
        void open().then((shown) => (shown ? undefined : say({ tone: "failed", message: copy.openFailed })))
      }
    >
      {state === "pending" ? copy.opening : state === "failed" ? copy.retry : copy.openFolder}
    </Button>
  );
}

/** The line a change left, kept with the view it belongs to: another view drops it. */
const useFlash = (view: MemoryView) => {
  const [flash, setFlash] = useState<{ readonly key: string; readonly flash: MemoryFlash } | null>(null);
  const say: Say = (next, at = view) => setFlash({ key: flashKeyOf(at), flash: next });
  return { flash: flash?.key === flashKeyOf(view) ? flash.flash : null, say };
};

/**
 * The Memory page: what every hob remembers, About you and each project, read through the hub, and
 * changed through it (#959). Its views live in the address (STD-REACT-002): the overview, What
 * changed, To review, a scope, a page with its history, the editor, and a search. While memory does
 * not answer it shows the pages it last loaded under a notice, and tries again every 30 seconds.
 */
export function MemoryPage({ search }: { search: MemorySearch }) {
  const view = memoryViewOf(search);
  const reads = useMemory(view);
  const writes = useMemoryWrites();
  const { flash, say } = useFlash(view);
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
          <span className="flex items-center gap-2">
            <CheckNow />
            <OpenFolder say={say} />
            <MemorySearchForm view={view} />
          </span>
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
          {flash !== null && <FlashLine message={flash.message} tone={flash.tone} onUndo={flash.undo} />}
          <ViewBody view={view} reads={reads} review={review} now={now} act={{ writes, say }} />
        </main>
      </div>
    </div>
  );
}
