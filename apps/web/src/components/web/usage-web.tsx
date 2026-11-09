import type { Agent, AgentId, UsagePeriod, WebHobUsage, WebTurnUsage, WebUsageSummary } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { webSummaryQuery } from "../../api/web.ts";
import { formatWeekday } from "../../lib/format.ts";
import { periodStart } from "../../lib/usage.ts";
import { messages } from "./messages.ts";
import { ReadFailed } from "./read-failed.tsx";
import { SearchesBar, UsageTable, WhoCell } from "./usage-web-table.tsx";
import { WebIcon } from "./web-icon.tsx";

const copy = messages.usage;

const VIEWS = ["hobs", "turns"] as const;
type View = (typeof VIEWS)[number];

/** How many hobs By hob shows before Show all. */
const TOP_HOBS = 5;

/**
 * Usage › Searches and pages (ADR 036, Usage and limits): the period's searches, pages and what
 * searches cost, then each hob's counts with how often it reached a limit, or the busiest turns.
 */
export function WebUsageSection({
  days,
  period,
  looks,
}: {
  days: UsagePeriod;
  /** The period in words, such as "last 7 days". */
  period: string;
  looks: ReadonlyMap<AgentId, Agent>;
}) {
  const since = periodStart(new Date(), Number(days)).toISOString();
  const summary = useQuery(webSummaryQuery(since));
  const [view, setView] = useState<View>("hobs");
  const data = summary.data;
  return (
    <section aria-label={copy.heading} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="lbl m-0 flex items-center gap-1.5 text-meta text-label">
          <WebIcon kind="globe" />
          {copy.heading}
        </h2>
        <SegmentedControl aria-label={copy.view} size="sm" value={view} onValueChange={(next: View) => setView(next)}>
          {VIEWS.map((each) => (
            <SegmentedControlItem key={each} value={each}>
              {each === "hobs" ? copy.byHob : copy.busiest}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      {summary.isPending && (
        <div role="status">
          <span className="sr-only">{messages.reading}</span>
          <Skeleton surface="card" width="60%" />
        </div>
      )}
      {summary.isError && <ReadFailed text={copy.failed} onRetry={() => void summary.refetch()} />}
      {data !== undefined && (
        <>
          <Totals summary={data} period={period} />
          {data.hobs.length === 0 ? (
            <p className="m-0 rounded-card bg-card px-4 py-3.5 text-ui text-text-secondary">{copy.none}</p>
          ) : view === "hobs" ? (
            <ByHob hobs={data.hobs} looks={looks} />
          ) : (
            <BusiestTurns turns={data.busiestTurns} count={data.turns} looks={looks} />
          )}
          <p className="m-0 text-detail text-text-secondary">
            {copy.countedNote}{" "}
            <Link
              to="/settings/$section"
              params={{ section: "web" }}
              className="text-text-strong underline-offset-2 hover:underline"
            >
              {copy.limitsLink}
            </Link>
          </p>
        </>
      )}
    </section>
  );
}

function Totals({ summary, period }: { summary: WebUsageSummary; period: string }) {
  const { totals } = summary;
  const cost = totals.estimatedCostUsd;
  const cards = [
    { big: copy.searches({ count: totals.searches }), small: copy.searchesLabel({ period }) },
    { big: copy.searches({ count: totals.pages }), small: copy.pagesLabel({ period }) },
    cost === null
      ? { big: copy.noCost, small: copy.noCostNote }
      : { big: copy.cost({ usd: cost }), small: copy.costNote({ count: totals.billedSearches }) },
  ];
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-3">
      {cards.map((card) => (
        <li key={card.small} className="flex flex-col gap-1 rounded-card bg-card px-4 py-3.5">
          <strong className="font-mono text-text-strong tabular-nums">{card.big}</strong>
          <span className="text-detail text-text-secondary">{card.small}</span>
        </li>
      ))}
    </ul>
  );
}

function ByHob({ hobs, looks }: { hobs: ReadonlyArray<WebHobUsage>; looks: ReadonlyMap<AgentId, Agent> }) {
  const [all, setAll] = useState(false);
  const most = Math.max(1, ...hobs.map((hob) => hob.searches));
  const shown = all ? hobs : hobs.slice(0, TOP_HOBS);
  return (
    <>
      <UsageTable first={copy.columns.hob} searchesEnd={false}>
        {shown.map((hob) => {
          const look = looks.get(hob.agentId);
          return (
            <tr key={hob.agentId} className="shadow-[inset_0_1px_0_var(--color-line)]">
              <WhoCell
                look={look}
                title={
                  look === undefined ? (
                    <span className="font-semibold text-text-strong">{copy.untitled}</span>
                  ) : (
                    <Link
                      to="/hobs/$hobId"
                      params={{ hobId: look.id }}
                      className="font-semibold text-text-strong underline-offset-2 hover:underline"
                    >
                      {look.name}
                    </Link>
                  )
                }
                sub={look === undefined ? "" : copy.runtime[look.runtime]}
              />
              <SearchesBar searches={hob.searches} most={most} />
              <td className="px-3 py-2.5 text-end font-mono tabular-nums">{hob.pages}</td>
              <td className="px-3 py-2.5">
                {hob.turnsAtLimit > 0 ? (
                  <Badge variant="needs-you">{copy.atLimit({ count: hob.turnsAtLimit })}</Badge>
                ) : (
                  <span className="text-meta text-label">{copy.within}</span>
                )}
              </td>
            </tr>
          );
        })}
      </UsageTable>
      <p className="m-0 flex flex-wrap items-center gap-3 text-detail text-text-secondary">
        {hobs.length > TOP_HOBS && (
          <Button variant="ghost" size="xs" onClick={() => setAll(!all)}>
            {all ? copy.showTop : copy.showAll({ count: hobs.length })}
          </Button>
        )}
        {copy.sortNote}
      </p>
    </>
  );
}

function BusiestTurns({
  turns,
  count,
  looks,
}: {
  turns: ReadonlyArray<WebTurnUsage>;
  count: number;
  looks: ReadonlyMap<AgentId, Agent>;
}) {
  return (
    <>
      <UsageTable first={copy.columns.turn} searchesEnd>
        {turns.map((turn) => {
          const look = looks.get(turn.agentId);
          const title = turn.threadId === null ? copy.taskTurn : (turn.threadTitle ?? copy.untitled);
          return (
            <tr key={turn.turn} className="shadow-[inset_0_1px_0_var(--color-line)]">
              <WhoCell
                look={look}
                title={
                  turn.threadId === null ? (
                    <span className="text-text-strong">{title}</span>
                  ) : (
                    <Link
                      to="/hobs/$hobId/threads/$threadId"
                      params={{ hobId: turn.agentId, threadId: turn.threadId }}
                      search={turn.messageId === null ? {} : { message: turn.messageId }}
                      className="text-text-strong underline-offset-2 hover:underline"
                    >
                      {title}
                    </Link>
                  )
                }
                sub={copy.turnBy({ name: look?.name ?? "", when: formatWeekday(turn.at) })}
              />
              <td className="px-3 py-2.5 text-end font-mono tabular-nums">{turn.searches}</td>
              <td className="px-3 py-2.5 text-end font-mono tabular-nums">{turn.pages}</td>
              <td className="px-3 py-2.5">
                {turn.reachedLimit !== null && <Badge variant="needs-you">{copy.reached[turn.reachedLimit]}</Badge>}
              </td>
            </tr>
          );
        })}
      </UsageTable>
      <p className="m-0 text-detail text-text-secondary">{copy.turnsNote({ count })}</p>
    </>
  );
}
