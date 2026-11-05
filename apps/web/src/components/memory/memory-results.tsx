import { type MemoryHit, type MemoryScope, memoryKindOf, memoryScopeKey, type SnippetPart } from "@hobbots/domain";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type HobDirectory,
  hitParts,
  memorySearchOf,
  type ScopeNav,
  scopeWhere,
  searchScopes,
} from "./memory-model.ts";
import { RowList } from "./memory-overview.tsx";
import { KindTag } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** A hit's snippet with the words that matched marked. */
function Marked({ parts }: { parts: ReadonlyArray<SnippetPart> }) {
  return parts.map((part, index) =>
    part.match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
      <mark key={index} className="rounded-tag bg-lantern/28 px-0.5 text-text-strong">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

function HitRow({ hit, q, hobs }: { hit: MemoryHit; q: string; hobs: HobDirectory }) {
  return (
    <li>
      <Link
        to="/memory"
        search={memorySearchOf({ _tag: "Page", scope: hit.scope, path: hit.path, version: null })}
        className="flex w-full flex-col gap-1 bg-card px-3.5 py-3 text-start text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover"
      >
        <span className="flex flex-wrap items-center gap-2">
          <KindTag kind={memoryKindOf(hit.path)} />
          <span className="text-body font-semibold">{hit.title}</span>
        </span>
        <span className="text-ui text-text">
          <Marked parts={hitParts(hit.snippet, q)} />
        </span>
        <span className="text-meta text-label">{scopeWhere(hit.scope, hobs)}</span>
      </Link>
    </li>
  );
}

/** A search across memory: where to look, then every page that mentions the words. */
export function MemoryResults({
  q,
  within,
  hits,
  nav,
  hobs,
}: {
  q: string;
  within: MemoryScope | null;
  /** Undefined while the search runs. */
  hits: ReadonlyArray<MemoryHit> | undefined;
  nav: ScopeNav;
  hobs: HobDirectory;
}) {
  const navigate = useNavigate();
  const scopes = searchScopes(nav);
  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="m-0 font-heading text-[24px] leading-[30px] font-bold text-text-strong">
          {hits === undefined ? q : copy.results.head({ count: hits.length, q })}
        </h2>
        <span className="text-ui text-text-secondary">
          {copy.results.sub({ projects: nav.projects.length, hobs: nav.hobs.length })}
        </span>
      </header>
      <FilterChips
        aria-label={copy.results.where}
        value={within === null ? "all" : memoryScopeKey(within)}
        onValueChange={(key) => {
          const scope = scopes.find((entry) => entry.key === key)?.scope ?? null;
          void navigate({ to: "/memory", search: memorySearchOf({ _tag: "Search", q, within: scope }) });
        }}
      >
        {scopes.map((entry) => (
          <FilterChip key={entry.key} value={entry.key}>
            {entry.label}
          </FilterChip>
        ))}
      </FilterChips>
      {hits === undefined && (
        <div aria-busy="true" className="flex flex-col gap-2">
          <span role="status" className="sr-only">
            {copy.results.searching}
          </span>
          {["70%", "55%", "62%"].map((width) => (
            <Skeleton key={width} width={width} />
          ))}
        </div>
      )}
      {hits !== undefined && hits.length > 0 && (
        <RowList label={copy.results.head({ count: hits.length, q })}>
          {hits.map((hit) => (
            <HitRow key={`${memoryScopeKey(hit.scope)}/${hit.path}`} hit={hit} q={q} hobs={hobs} />
          ))}
        </RowList>
      )}
      {hits !== undefined && hits.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-8 py-12 text-center">
          <span className="font-heading text-heading font-bold text-text-strong">{copy.results.none}</span>
          <span className="text-text-secondary">{copy.results.noneHint}</span>
        </div>
      )}
      <p className="m-0 text-detail text-label">{copy.results.footnote}</p>
    </div>
  );
}
