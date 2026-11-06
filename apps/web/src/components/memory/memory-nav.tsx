import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { formatCount } from "../../lib/format.ts";
import { type MemoryView, memorySearchOf, type ScopeNav, type ScopeRow } from "./memory-model.ts";
import { MemoryIcon, type MemoryIconName, ScopeMark } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** The router marks only an exact address current; the nav marks a scope current itself. */
const EXACT = { exact: true } as const;

const row =
  "flex w-full min-h-row-min items-center gap-2.5 rounded-control px-2.5 py-2 text-start text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover aria-[current=page]:bg-card";

/** Whether `view` shows `scope`'s pages or one of them. */
const showsScope = (view: MemoryView, key: string) =>
  (view._tag === "Scope" || view._tag === "Page") && memorySearchOf(view).scope === key;

function Section({
  to,
  icon,
  label,
  current,
  extra,
}: {
  to: MemoryView;
  icon: MemoryIconName;
  label: string;
  current: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <Link
      to="/memory"
      search={memorySearchOf(to)}
      activeOptions={EXACT}
      aria-current={current ? "page" : undefined}
      className={row}
    >
      <span className="text-text-secondary">
        <MemoryIcon name={icon} />
      </span>
      <span className="flex-1 text-ui">{label}</span>
      {extra}
    </Link>
  );
}

function Count({ pages }: { pages: number | null }) {
  if (pages === null) return null;
  return <span className="text-meta text-label tabular-nums">{formatCount(pages)}</span>;
}

function ScopeLink({ entry, view }: { entry: ScopeRow; view: MemoryView }) {
  return (
    <Link
      to="/memory"
      search={memorySearchOf({ _tag: "Scope", scope: entry.scope, kind: null })}
      activeOptions={EXACT}
      aria-current={showsScope(view, entry.key) ? "page" : undefined}
      className={row}
    >
      <ScopeMark scope={entry.scope} hob={entry.hob} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui">{entry.name}</span>
        {entry.sub !== "" && <span className="truncate text-meta text-label">{entry.sub}</span>}
      </span>
      <Count pages={entry.pages} />
    </Link>
  );
}

function NavLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="lbl m-0 px-2.5 pt-3.5 pb-1 text-meta text-label">{children}</h2>;
}

/**
 * The scopes beside the page: the overview, What changed and To review, then About you and the projects,
 * then every hob. While memory is read, the projects hold two skeleton rows.
 */
export function MemoryNav({
  nav,
  view,
  loading,
  newChanges,
  toReview,
}: {
  nav: ScopeNav;
  view: MemoryView;
  loading: boolean;
  /** Changes the stream brought since the page opened; none shows nothing. */
  newChanges: number;
  /** Shares that wait for you and what Check now found; none shows no count. */
  toReview: number;
}) {
  return (
    <nav
      aria-label={copy.nav.label}
      className="flex w-[260px] flex-none flex-col gap-0.5 overflow-y-auto border-e border-line bg-panel px-2.5 py-3 max-[1180px]:w-[220px]"
    >
      <Section to={{ _tag: "Overview" }} icon="overview" label={copy.nav.overview} current={view._tag === "Overview"} />
      <Section
        to={{ _tag: "Changes", show: "all" }}
        icon="changes"
        label={copy.nav.changes}
        current={view._tag === "Changes"}
        extra={
          newChanges > 0 ? (
            <span className="text-meta text-label tabular-nums">{copy.nav.newChanges({ count: newChanges })}</span>
          ) : undefined
        }
      />
      <Section
        to={{ _tag: "Review", item: null }}
        icon="review"
        label={copy.review.nav}
        current={view._tag === "Review"}
        extra={toReview > 0 ? <Count pages={toReview} /> : undefined}
      />
      <NavLabel>{copy.nav.shared}</NavLabel>
      <ScopeLink entry={nav.about} view={view} />
      {loading && <NavSkeleton />}
      {nav.projects.map((entry) => (
        <ScopeLink key={entry.key} entry={entry} view={view} />
      ))}
      <NavLabel>{copy.nav.hobs}</NavLabel>
      {nav.hobs.map((entry) => (
        <ScopeLink key={entry.key} entry={entry} view={view} />
      ))}
    </nav>
  );
}

/** Two skeleton rows, as a nav shows while what it lists is read. */
export function NavSkeleton() {
  return (
    <>
      {["90px", "120px"].map((width) => (
        <div key={width} aria-hidden className={cn(row, "cursor-default hover:bg-transparent")}>
          <Skeleton shape="tile" className="size-4" />
          <Skeleton width={width} />
        </div>
      ))}
    </>
  );
}
