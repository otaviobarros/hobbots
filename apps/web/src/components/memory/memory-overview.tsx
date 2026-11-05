import type { MemoryChange, MemoryPageSummary } from "@hobbots/domain";
import { memoryKindOf } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { formatAgo, formatCount } from "../../lib/format.ts";
import { type HobDirectory, memorySearchOf, scopeWhere } from "./memory-model.ts";
import { GroupLabel, KindTag, MemoryCard, ScopeMark } from "./memory-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;

const rowLink =
  "flex w-full items-start gap-2.5 bg-card px-3.5 py-3 text-start text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover";

/** A list of rows on one card, a rule between each, as the design's grouped rows. */
export function RowList({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-col overflow-hidden rounded-card p-0 [&>li+li]:border-t [&>li+li]:border-line"
    >
      {children}
    </ul>
  );
}

function LearnedRow({ change, hobs, now }: { change: MemoryChange; hobs: HobDirectory; now: Date }) {
  const hob = change.author?._tag === "Hob" ? hobs.get(change.author.agentId) : undefined;
  const kind = memoryKindOf(change.path);
  return (
    <li>
      <Link
        to="/memory"
        search={memorySearchOf({ _tag: "Page", scope: change.scope, path: change.path, version: null })}
        className={rowLink}
      >
        <span className="mt-0.5">
          <ScopeMark scope={change.scope} hob={hob} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-detail text-text-secondary">
            {copy.overview.learned({ who: hob?.name ?? copy.nav.formerHob })}
          </span>
          <span className="text-body font-semibold">{change.title}</span>
          <span className="truncate text-detail text-label">{scopeWhere(change.scope, hobs)}</span>
        </span>
        <span className="flex flex-none flex-col items-end gap-1.5">
          <KindTag kind={kind} />
          <span className="text-meta text-label">{formatAgo(change.at, now)}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The overview: what hobs learned this week, then a peek at About you. Rows open the page they
 * name.
 */
export function MemoryOverviewView({
  learned,
  about,
  hobs,
  now,
}: {
  learned: ReadonlyArray<MemoryChange>;
  about: ReadonlyArray<MemoryPageSummary> | undefined;
  hobs: HobDirectory;
  now: Date;
}) {
  return (
    <div className="flex max-w-[900px] flex-col gap-7">
      <section aria-label={copy.overview.recent} className="flex flex-col gap-2.5">
        <GroupLabel>
          <h2 className="lbl m-0 text-label">{copy.overview.recent}</h2>
          <span className="text-meta text-label tabular-nums">{formatCount(learned.length)}</span>
        </GroupLabel>
        {learned.length === 0 ? (
          <p className="m-0 text-ui text-text-secondary">{copy.overview.nothingRecent}</p>
        ) : (
          <RowList>
            {learned.map((change) => (
              <LearnedRow key={`${change.path}-${change.version}`} change={change} hobs={hobs} now={now} />
            ))}
          </RowList>
        )}
      </section>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <MemoryCard label={copy.overview.about}>
          <GroupLabel>
            <h2 className="lbl m-0 flex-1 text-label">{copy.overview.about}</h2>
            <Link
              to="/memory"
              search={memorySearchOf({ _tag: "Scope", scope: { _tag: "Everyone" }, kind: null })}
              className="text-detail text-link"
            >
              {copy.overview.open}
            </Link>
          </GroupLabel>
          <AboutPeek about={about} />
          <span className="text-meta text-label">{copy.overview.aboutHint}</span>
        </MemoryCard>
      </div>
    </div>
  );
}

function AboutPeek({ about }: { about: ReadonlyArray<MemoryPageSummary> | undefined }) {
  if (about === undefined) return <PeekSkeleton />;
  if (about.length === 0) return <span className="text-ui text-text-secondary">{copy.overview.aboutEmpty}</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {about.slice(0, 3).map((page) => (
        <li key={page.path} className="flex gap-2 text-ui before:text-label before:content-['◆']">
          <span>{page.title}</span>
        </li>
      ))}
    </ul>
  );
}

function PeekSkeleton() {
  return (
    <span aria-hidden className="flex flex-col gap-2.5">
      {["85%", "70%", "60%"].map((width) => (
        <Skeleton key={width} surface="card" width={width} />
      ))}
    </span>
  );
}

/** The overview while memory is first read: skeleton rows in the shape of Recently learned. */
export function MemoryOverviewSkeleton() {
  return (
    <div aria-busy="true" className="flex max-w-[900px] flex-col gap-7">
      <section aria-label={copy.overview.recent} className="flex flex-col gap-2.5">
        <GroupLabel>
          <h2 className="lbl m-0 text-label">{copy.overview.recent}</h2>
        </GroupLabel>
        <div aria-hidden className="flex flex-col overflow-hidden rounded-card">
          {["62%", "48%", "56%"].map((width) => (
            <div key={width} className="flex items-start gap-2.5 bg-card px-3.5 py-3">
              <Skeleton shape="tile" surface="card" className="size-7.5" />
              <span className="flex flex-1 flex-col gap-2 pt-0.5">
                <Skeleton surface="card" width="90px" />
                <Skeleton surface="card" width={width} />
                <Skeleton surface="card" width="220px" />
              </span>
              <Skeleton shape="block" surface="card" width="56px" />
            </div>
          ))}
        </div>
        <p role="status" className="m-0 text-detail text-text-secondary">
          {copy.overview.loading}
        </p>
      </section>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <MemoryCard label={copy.overview.about}>
          <h2 className="lbl m-0 text-label">{copy.overview.about}</h2>
          <PeekSkeleton />
        </MemoryCard>
      </div>
    </div>
  );
}

/** Nothing remembered yet: how memory fills, in three steps. */
export function MemoryNothingYet() {
  return (
    <div className="flex max-w-form-max flex-col gap-6">
      <div className="flex flex-col gap-2.5 pt-2 pb-1">
        <h2 className="m-0 font-heading text-display font-bold text-text-strong">{copy.empty.title}</h2>
        <p className="m-0 max-w-[600px] text-text-secondary">{copy.empty.body}</p>
      </div>
      <ol className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[900px]:grid-cols-3">
        {copy.empty.steps.map((step, at) => (
          <li key={step.title} className="flex flex-col gap-1.5 rounded-card bg-card p-4">
            <span className="text-meta text-label tabular-nums">{formatCount(at + 1)}</span>
            <span className="text-body font-semibold text-text-strong">{step.title}</span>
            <span className="text-detail text-text-secondary">{step.body}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 text-detail text-label">{copy.empty.footnote}</p>
    </div>
  );
}
