import type { Agent, AgentId, UsagePeriod, WebHobUsage, WebTurnUsage, WebUsageSummary } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { webSummaryQuery } from "../../api/web.ts";
import { formatWeekday } from "../../lib/format.ts";
import { periodStart } from "../../lib/usage.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";
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
      {summary.isError && <p className="m-0 text-ui text-rose">{copy.failed}</p>}
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

/** A hob's tile, or a plain square for a hob no longer listed. */
function Tile({ look }: { look: Agent | undefined }) {
  return look === undefined ? (
    <span aria-hidden className="size-7 flex-none rounded-tile bg-line-2" />
  ) : (
    <HobSprite hob={look} size={28} />
  );
}

const headClass = "px-3 py-2 text-start text-meta font-normal text-label";

/** By hob's and Busiest turns' table: its head, then the rows it is given. */
function UsageTable({
  first,
  searchesEnd,
  children,
}: {
  first: string;
  /** Whether the searches column is a number at its end rather than a bar. */
  searchesEnd: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-card bg-card">
      <table className="w-full border-collapse text-ui">
        <thead>
          <tr>
            <th className={headClass}>{first}</th>
            <th className={searchesEnd ? `${headClass} text-end` : headClass}>{copy.columns.searches}</th>
            <th className={`${headClass} text-end`}>{copy.columns.pages}</th>
            <th className={headClass}>{copy.columns.limits}</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
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
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-2.5">
                  <Tile look={look} />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold text-text-strong">{look?.name ?? copy.untitled}</span>
                    <span className="text-meta text-label">{look === undefined ? "" : copy.runtime[look.runtime]}</span>
                  </span>
                </span>
              </td>
              <td className="w-[40%] px-3 py-2.5">
                <span className="flex items-center gap-3">
                  <span aria-hidden className="h-2 min-w-[60px] flex-1 overflow-hidden rounded-dot bg-line-2">
                    <span
                      className="block h-full rounded-dot bg-moonlight"
                      style={{ width: `${(hob.searches / most) * 100}%` }}
                    />
                  </span>
                  <span className="w-8 text-end font-mono font-bold text-text-strong tabular-nums">{hob.searches}</span>
                </span>
              </td>
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
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-2.5">
                  <Tile look={look} />
                  <span className="flex min-w-0 flex-col">
                    {turn.threadId === null ? (
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
                    )}
                    <span className="text-meta text-label">
                      {copy.turnBy({ name: look?.name ?? "", when: formatWeekday(turn.at) })}
                    </span>
                  </span>
                </span>
              </td>
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
