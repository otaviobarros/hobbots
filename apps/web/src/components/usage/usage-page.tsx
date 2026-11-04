import type { Agent, AgentId, UsagePeriod } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { agentsQuery, archivedAgentsQuery, runtimesQuery, usageQuery } from "../../api/queries.ts";
import { dailyUsage, hobShares, localDay } from "../../lib/usage.ts";
import { Page } from "../pages.tsx";
import { DailyChart, HobBreakdown } from "./hob-breakdown.tsx";
import { messages } from "./messages.ts";
import { ManageProviders, PlanShelf } from "./plan-card.tsx";

const PERIODS = ["7", "30"] as const satisfies ReadonlyArray<UsagePeriod>;

/** A section of the page under a small label, with an optional control at its end. */
function Section({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="lbl m-0 text-meta text-label">{label}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** The period picker. The period lives in the URL (STD-REACT-002), so picking one navigates. */
function PeriodPicker({ days }: { days: UsagePeriod }) {
  const navigate = useNavigate();
  return (
    <SegmentedControl
      aria-label={messages.period.label}
      value={days}
      onValueChange={(period: UsagePeriod) => void navigate({ to: "/usage", search: { days: Number(period) } })}
    >
      {PERIODS.map((period) => (
        <SegmentedControlItem key={period} value={period}>
          {messages.period[period]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
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
    <Page icon="Usage" title={messages.title} intro={messages.intro} actions={<PeriodPicker days={days} />}>
      <div className="flex w-full max-w-[880px] flex-col gap-7">
        {report.isError ? (
          <div className="flex items-center gap-3">
            <p className="m-0 text-rose">{messages.failed}</p>
            <Button variant="outline" size="xs" onClick={() => void report.refetch()}>
              {messages.retry}
            </Button>
          </div>
        ) : (
          <>
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
                  <span className="text-sm text-text-secondary">
                    {messages.daily.total({ count: replies, period })}
                  </span>
                )
              }
            >
              {report.data && <DailyChart days={daily} />}
            </Section>
            <Section label={messages.hobs.label}>
              {report.data && <HobBreakdown hobs={hobShares(report.data.hobs)} looks={looks} period={period} />}
              <p className="m-0 text-meta text-label">{messages.note}</p>
            </Section>
          </>
        )}
      </div>
    </Page>
  );
}
