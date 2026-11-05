import type { MemoryCheck } from "@hobbots/api";
import type { MemoryShare } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import { memoryNotAnswering } from "../../api/memory-pages.ts";
import { useCheckNow } from "../../api/memory-shares.ts";
import { formatWhen } from "../../lib/time.ts";
import { type HobDirectory, memorySearchOf, scopeName, scopeWhere } from "./memory-model.ts";
import { ScopeMark } from "./memory-parts.tsx";
import { messages } from "./messages.ts";
import { findingWhat, openItem, type ReviewItem, reviewItems, shareDestination, shareFrom, shareWhat } from "./review-model.ts";
import { ShareDecision, ShareDiff } from "./share-card.tsx";

const copy = messages.review;

/**
 * Check now, in the page's header: it checks every scope for pages that disagree or look out of
 * date, changing nothing, and opens To review with what it found.
 */
export function CheckNow() {
  const check = useCheckNow();
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-3">
      <p role="status" className="m-0 text-meta text-text-secondary empty:hidden">
        {check.isSuccess ? copy.checked({ count: check.data.findings.length }) : null}
        {check.isError ? (memoryNotAnswering(check.error) ? copy.checkFailed : copy.failed) : null}
      </p>
      <Button
        variant="outline"
        title={copy.checkHint}
        disabled={check.isPending}
        onClick={() =>
          check.mutate(undefined, {
            onSuccess: () => void navigate({ to: "/memory", search: memorySearchOf({ _tag: "Review", item: null }) }),
          })
        }
      >
        {check.isPending ? copy.checking : copy.checkNow}
      </Button>
    </div>
  );
}

/** One row of the list: the hob that asked, or Check now, what it is and its tag. */
function ReviewRow({ item, hobs, current }: { item: ReviewItem; hobs: HobDirectory; current: boolean }) {
  const hob = item._tag === "Share" ? hobs.get(item.share.agentId) : undefined;
  return (
    <Link
      to="/memory"
      search={memorySearchOf({ _tag: "Review", item: item.key })}
      aria-current={current ? "page" : undefined}
      className="flex items-start gap-2.5 rounded-control p-2.5 text-start text-text-strong no-underline hover:bg-hover aria-[current=page]:bg-card"
    >
      {item._tag === "Share" ? (
        <ScopeMark scope={{ _tag: "Hob", agentId: item.share.agentId }} hob={hob} />
      ) : (
        <ScopeMark scope={item.finding.scope} hob={undefined} />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-detail text-text-secondary">
            {item._tag === "Share" ? copy.from({ who: shareFrom(item.share, hobs) }) : copy.foundBy}
          </span>
          <ReviewTag item={item} />
        </span>
        <span className="text-ui font-semibold">
          {item._tag === "Share" ? shareWhat(item.share, shareFrom(item.share, hobs)) : findingWhat(item.finding)}
        </span>
      </span>
    </Link>
  );
}

function ReviewTag({ item }: { item: ReviewItem }) {
  if (item._tag === "Share") return <Badge variant="needs-you">{copy.share}</Badge>;
  return item.finding.kind === "disagree" ? (
    <Badge variant="needs-you">{copy.disagreeTag}</Badge>
  ) : (
    <Badge variant="waiting">{copy.staleTag}</Badge>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,140px)_1fr] text-ui">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="border-b border-line py-2 pe-3 text-label">{term}</dt>
          <dd className="m-0 border-b border-line py-2 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A share in full: where it goes, the page it adds, and your decision, edited here if you like. */
export function ShareReview({ share, hobs, now }: { share: MemoryShare; hobs: HobDirectory; now: Date }) {
  const who = shareFrom(share, hobs);
  const destination = shareDestination(share, hobs);
  return (
    <article
      aria-label={shareWhat(share, who)}
      className="flex max-w-165 min-w-0 flex-1 animate-hb-in flex-col gap-4"
    >
      <header className="flex flex-col gap-2.5">
        <span className="flex flex-wrap items-center gap-2 text-detail text-text-secondary">
          <Badge variant={share.state === "waiting" ? "needs-you" : "muted"}>{copy.share}</Badge>
          <span>{copy.route({ who, destination })}</span>
        </span>
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{shareWhat(share, who)}</h2>
      </header>
      <ShareDiff share={share} hobs={hobs} />
      <ShareDecision key={share.id} share={share} hobs={hobs} edit="here" />
      <Facts
        rows={[
          [copy.facts.suggestedBy, `${who} · ${formatWhen(share.createdAt, now)}`],
          [
            copy.facts.ifShared,
            share.scope._tag === "Project"
              ? copy.footProject({ name: scopeName(share.scope, hobs) })
              : copy.footEveryone,
          ],
        ]}
      />
    </article>
  );
}

/** A finding in full: what Check now said, and the pages it is about. */
function FindingReview({ item, hobs }: { item: Extract<ReviewItem, { _tag: "Finding" }>; hobs: HobDirectory }) {
  const { finding } = item;
  return (
    <article aria-label={findingWhat(finding)} className="flex max-w-165 min-w-0 flex-1 animate-hb-in flex-col gap-4">
      <header className="flex flex-col gap-2.5">
        <span className="flex flex-wrap items-center gap-2 text-detail text-text-secondary">
          <ReviewTag item={item} />
          <span>{scopeWhere(finding.scope, hobs)}</span>
        </span>
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{findingWhat(finding)}</h2>
        <p className="m-0 text-text [overflow-wrap:anywhere]">{finding.message}</p>
      </header>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {finding.paths.map((path) => (
          <li key={path} className="flex items-center gap-3 rounded-card bg-card px-4 py-3">
            <code className="min-w-0 flex-1 truncate text-ui">{path}</code>
            <Link
              to="/memory"
              search={memorySearchOf({ _tag: "Page", scope: finding.scope, path, version: null })}
              className="text-link"
            >
              {copy.openPage}
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * Memory › To review: the shares that wait for you and what Check now found, the open one beside the
 * list. A share decided here stays open, with its outcome and Undo.
 */
export function MemoryReviewView({
  item,
  shares,
  check,
  hobs,
  now,
}: {
  item: string | null;
  shares: ReadonlyArray<MemoryShare> | undefined;
  check: MemoryCheck | undefined;
  hobs: HobDirectory;
  now: Date;
}) {
  const items = reviewItems(shares ?? [], check);
  const open = openItem(items, shares ?? [], item);
  if (shares !== undefined && open === undefined) {
    return (
      <div className="flex animate-hb-in flex-col items-center gap-2.5 px-8 py-16 text-center">
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{copy.nothing}</h2>
        <p className="m-0 max-w-105 text-text-secondary">{copy.nothingHint}</p>
        <Button asChild variant="outline">
          <Link to="/memory" search={{}}>
            {copy.back}
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex w-80 flex-none flex-col gap-1">
        <nav aria-label={copy.listLabel} className="flex flex-col gap-1">
          {items.map((each) => (
            <ReviewRow key={each.key} item={each} hobs={hobs} current={each.key === open?.key} />
          ))}
        </nav>
        <p className="m-0 px-2.5 pt-2 text-meta text-label">{copy.presetNote}</p>
      </div>
      {open?._tag === "Share" && <ShareReview share={open.share} hobs={hobs} now={now} />}
      {open?._tag === "Finding" && <FindingReview item={open} hobs={hobs} />}
    </div>
  );
}
