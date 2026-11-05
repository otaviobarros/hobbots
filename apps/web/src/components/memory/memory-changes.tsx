import { type MemoryChange, memoryKindOf, memoryScopeKey } from "@hobbots/domain";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Link, useNavigate } from "@tanstack/react-router";
import { formatCount, formatDay, formatTime } from "../../lib/format.ts";
import {
  type ChangeFilter,
  changesByDay,
  filterChanges,
  type HobDirectory,
  memorySearchOf,
  scopeWhere,
} from "./memory-model.ts";
import { RowList } from "./memory-overview.tsx";
import { ScopeMark } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

const FILTERS = ["all", "hobs", "you"] as const satisfies ReadonlyArray<ChangeFilter>;

function ChangeRow({ change, hobs }: { change: MemoryChange; hobs: HobDirectory }) {
  const hob = change.author?._tag === "Hob" ? hobs.get(change.author.agentId) : undefined;
  const byYou = change.author?._tag === "You";
  const who = hob?.name ?? copy.nav.formerHob;
  const kind = copy.kinds[memoryKindOf(change.path)].one;
  return (
    <li className="flex items-start gap-2.5 bg-card px-3.5 py-3">
      <span className="mt-0.5">
        <ScopeMark scope={change.scope} hob={hob} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-meta font-semibold text-text-secondary">
            {byYou ? copy.changes.savedByYou : copy.changes.savedBy({ who })}
          </span>
          <span className="text-meta text-label">{formatTime(change.at)}</span>
        </span>
        <span className="text-body text-text-strong">
          {byYou
            ? copy.changes.youSaved({ title: change.title })
            : copy.changes.saved({ who, kind, title: change.title })}
        </span>
        <span className="truncate text-detail text-text-secondary">{scopeWhere(change.scope, hobs)}</span>
      </span>
      <Link
        to="/memory"
        search={memorySearchOf({ _tag: "Page", scope: change.scope, path: change.path, version: change.version })}
        className="flex-none rounded-control px-2 py-0.5 text-meta text-text-secondary no-underline hover:bg-hover hover:text-text-strong"
      >
        {copy.changes.open}
      </Link>
    </li>
  );
}

/** What changed: every save memory made, by day, newest first, filtered by who made it. */
export function MemoryChangesView({
  changes,
  show,
  hobs,
  now,
}: {
  /** Undefined while they are read. */
  changes: ReadonlyArray<MemoryChange> | undefined;
  show: ChangeFilter;
  hobs: HobDirectory;
  now: Date;
}) {
  const navigate = useNavigate();
  const shown = changes === undefined ? undefined : filterChanges(changes, show);
  return (
    <div className="flex max-w-[700px] flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{copy.changes.title}</h2>
        <p className="m-0 text-text-secondary">{copy.changes.intro}</p>
      </header>
      {changes !== undefined && (
        <FilterChips
          aria-label={copy.changes.show}
          value={show}
          onValueChange={(next) =>
            void navigate({ to: "/memory", search: memorySearchOf({ _tag: "Changes", show: next as ChangeFilter }) })
          }
        >
          {FILTERS.map((filter) => (
            <FilterChip key={filter} value={filter} count={formatCount(filterChanges(changes, filter).length)}>
              {copy.changes.filters[filter]}
            </FilterChip>
          ))}
        </FilterChips>
      )}
      {shown === undefined && (
        <div aria-busy="true" className="flex flex-col gap-2">
          {["64%", "50%", "58%"].map((width) => (
            <Skeleton key={width} width={width} />
          ))}
        </div>
      )}
      {shown !== undefined && shown.length === 0 && (
        <p className="m-0 text-ui text-text-secondary">
          {changes?.length === 0 ? copy.changes.nothing : copy.changes.nothingHere}
        </p>
      )}
      {shown !== undefined &&
        changesByDay(shown, now).map((day) => {
          const label = day.label ?? formatDay(day.first);
          return (
            <section key={day.day} aria-label={label} className="flex flex-col gap-1">
              <h3 className="lbl m-0 text-label">{label}</h3>
              <RowList>
                {day.rows.map((change) => (
                  <ChangeRow
                    key={`${memoryScopeKey(change.scope)}/${change.path}/${change.version}`}
                    change={change}
                    hobs={hobs}
                  />
                ))}
              </RowList>
            </section>
          );
        })}
      <p className="m-0 text-detail text-label">{copy.changes.every}</p>
    </div>
  );
}
