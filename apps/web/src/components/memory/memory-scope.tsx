import { type MemoryKind, type MemoryPageSummary, type MemoryScope, memoryKindOf } from "@hobbots/domain";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Link, useNavigate } from "@tanstack/react-router";
import { formatCount, formatDay } from "../../lib/format.ts";
import { type HobDirectory, kindChips, kindGroups, memorySearchOf, scopeName } from "./memory-model.ts";
import { RowList } from "./memory-overview.tsx";
import { GroupLabel, KindTag, MemoryCard, PinnedTag, ScopeMark } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

const rowLink =
  "flex w-full items-start gap-2.5 bg-card px-3.5 py-3 text-start text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover";

function PageRow({ page }: { page: MemoryPageSummary }) {
  return (
    <li>
      <Link
        to="/memory"
        search={memorySearchOf({ _tag: "Page", scope: page.scope, path: page.path, version: null })}
        className={rowLink}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-body font-semibold">{page.title}</span>
          {page.pinned && <PinnedTag />}
        </span>
        <span className="flex-none pt-[3px] text-meta whitespace-nowrap text-label">{formatDay(page.updatedAt)}</span>
      </Link>
    </li>
  );
}

/** The header over a scope's pages: whose memory it is and how much it holds. */
function ScopeHeader({ scope, hobs, pages }: { scope: MemoryScope; hobs: HobDirectory; pages: number | undefined }) {
  const name = scopeName(scope, hobs);
  const hob = scope._tag === "Hob" ? hobs.get(scope.agentId) : undefined;
  const title =
    scope._tag === "Hob" ? copy.scope.hobTitle({ name }) : scope._tag === "Everyone" ? copy.scope.aboutTitle : name;
  const line =
    pages === undefined
      ? null
      : scope._tag === "Project"
        ? copy.scope.projectLine({ identity: scope.identity, count: pages })
        : scope._tag === "Everyone"
          ? copy.scope.aboutLine
          : copy.scope.hobLine({ count: pages });
  return (
    <header className="flex items-center gap-3.5">
      <ScopeMark scope={scope} hob={hob} size="lg" />
      <span className="flex min-w-0 flex-1 flex-col">
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{title}</h2>
        <span className="text-ui text-text-secondary">{line ?? <Skeleton width="24ch" />}</span>
      </span>
      {hob !== undefined && (
        <Link to="/hobs/$hobId" params={{ hobId: hob.id }} className="text-ui text-link">
          {copy.scope.openHob({ name })}
        </Link>
      )}
    </header>
  );
}

/** A scope's pages: kind chips, then each kind as its own group. */
export function MemoryScopeView({
  scope,
  kind,
  pages,
  hobs,
}: {
  scope: MemoryScope;
  kind: MemoryKind | null;
  /** Undefined while the pages are read. */
  pages: ReadonlyArray<MemoryPageSummary> | undefined;
  hobs: HobDirectory;
}) {
  const navigate = useNavigate();
  const who = scopeName(scope, hobs);
  const shown = pages?.filter((page) => kind === null || memoryKindOf(page.path) === kind);
  const groups = kindGroups(shown ?? []);
  return (
    <div className="flex flex-wrap items-start gap-7">
      <div className="flex min-w-0 max-w-[700px] flex-[1_1_520px] flex-col gap-5">
        <ScopeHeader scope={scope} hobs={hobs} pages={pages?.length} />
        {pages !== undefined && pages.length > 0 && (
          <FilterChips
            aria-label={copy.kindsLabel}
            value={kind ?? "all"}
            onValueChange={(next) =>
              void navigate({
                to: "/memory",
                search: memorySearchOf({ _tag: "Scope", scope, kind: next === "all" ? null : (next as MemoryKind) }),
              })
            }
          >
            {kindChips(pages).map((chip) => (
              <FilterChip key={chip.kind} value={chip.kind} count={formatCount(chip.count)}>
                {chip.label}
              </FilterChip>
            ))}
          </FilterChips>
        )}
        {pages === undefined && <ScopeSkeleton />}
        {pages !== undefined && groups.length === 0 && (
          <p className="m-0 text-ui text-text-secondary">
            {pages.length === 0 ? copy.scope.nothing : copy.scope.nothingOfKind}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.kind} aria-label={copy.kinds[group.kind].group} className="flex flex-col gap-1.5">
            <GroupLabel>
              <KindTag kind={group.kind} />
              <span className="text-meta text-label">{copy.kinds[group.kind].hint({ who })}</span>
            </GroupLabel>
            <RowList>
              {group.pages.map((page) => (
                <PageRow key={page.path} page={page} />
              ))}
            </RowList>
          </section>
        ))}
        {scope._tag === "Hob" && <p className="m-0 text-detail text-label">{copy.scope.hobFooter({ name: who })}</p>}
      </div>
      {scope._tag === "Project" && (
        <aside aria-label={copy.scope.projectReaders} className="flex w-[280px] flex-none flex-col gap-4">
          <MemoryCard label={copy.scope.projectReaders}>
            <h3 className="lbl m-0 text-label">{copy.scope.projectReaders}</h3>
            <span className="text-detail text-text-secondary">{copy.scope.projectReadersBody}</span>
          </MemoryCard>
        </aside>
      )}
    </div>
  );
}

function ScopeSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col overflow-hidden rounded-card">
      {["52%", "38%", "46%"].map((width) => (
        <div key={width} aria-hidden className="flex items-start gap-2.5 bg-card px-3.5 py-3">
          <Skeleton surface="card" width={width} />
        </div>
      ))}
    </div>
  );
}
