import type { Agent, AgentId, UsagePeriod } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { agentsQuery, archivedAgentsQuery, runtimesQuery, usageQuery } from "../../api/queries.ts";
import { dailyUsage, hobShares, localDay } from "../../lib/usage.ts";
import { Page } from "../pages.tsx";
import { DailyChart, HobBreakdown } from "./hob-breakdown.tsx";
import { messages } from "./messages.ts";
import { ManageProviders, PlanShelf } from "./plan-shelf.tsx";

const PERIODS = ["7", "30"] as const satisfies ReadonlyArray<UsagePeriod>;

function Section({
  label,
  extra,
  className,
  children,
}: {
  label: string;
  extra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn("cut flex min-w-0 flex-col gap-3 border-2 border-line bg-card px-[22px] py-[18px]", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="lbl text-moonlight">{label}</span>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** The period picker: a link per period, so the period lives in the URL (STD-REACT-002). */
function PeriodPicker({ days }: { days: UsagePeriod }) {
  return (
    <nav aria-label={messages.period.label} className="flex self-start border-2 border-control">
      {PERIODS.map((period) => (
        <Link
          key={period}
          to="/usage"
          search={{ days: Number(period) }}
          aria-current={period === days ? "page" : undefined}
          className={cn(
            "px-3.5 py-1.5 text-sm no-underline",
            period === days ? "bg-lantern font-bold text-ground" : "text-text-strong hover:bg-hover",
          )}
        >
          {messages.period[period]}
        </Link>
      ))}
    </nav>
  );
}

/** Screen 12, Usage: what's left of each AI plan and who used it, over 7 or 30 days (OP-002). */
export function UsagePage({ days }: { days: UsagePeriod }) {
  const report = useQuery(usageQuery(days, localDay(new Date())));
  const runtimes = useQuery(runtimesQuery);
  const active = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const looks = new Map<AgentId, Agent>(
    [...(active.data ?? []), ...(retired.data ?? [])].map((hob) => [hob.id, hob] as const),
  );
  const period = messages.period.last[days];
  const now = new Date(report.data?.until ?? Date.now());
  const daily = report.data ? dailyUsage(report.data.minutes, report.data.until, Number(days)) : [];
  const replies = daily.reduce((sum, day) => sum + day.replies, 0);

  return (
    <Page icon="Usage" title={messages.title} intro={messages.intro}>
      <PeriodPicker days={days} />
      {report.isError ? (
        <div className="flex items-center gap-3">
          <p className="m-0 text-rose">{messages.failed}</p>
          <Button variant="outline" size="xs" onClick={() => void report.refetch()}>
            {messages.retry}
          </Button>
        </div>
      ) : (
        <div className="grid gap-[18px] xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
          <Section label={messages.plans.label} extra={<ManageProviders />}>
            {runtimes.data ? (
              <PlanShelf runtimes={runtimes.data} plans={report.data?.plans} now={now} />
            ) : (
              <span className="text-text-secondary">{messages.plans.checking}</span>
            )}
          </Section>
          <Section
            label={messages.daily.label}
            extra={
              report.data && (
                <span className="text-sm text-text-secondary">{messages.daily.total({ count: replies, period })}</span>
              )
            }
          >
            {report.data && <DailyChart days={daily} />}
          </Section>
          <Section label={messages.hobs.label} className="xl:col-span-2">
            {report.data && <HobBreakdown hobs={hobShares(report.data.hobs)} looks={looks} period={period} />}
            <p className="m-0 text-xs text-label">{messages.note}</p>
          </Section>
        </div>
      )}
    </Page>
  );
}
