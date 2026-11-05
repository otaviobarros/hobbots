import type { Agent, AgentId, QuestUsage, UsagePeriod, UsageReport } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useWaitStage } from "@hobbots/ui/lib/wait-stage";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { agentsQuery, archivedAgentsQuery, plansQuery, runtimesQuery, usageQuery } from "../../api/queries.ts";
import { dailyUsage, type HobShare, hobShares, localDay, questShares, type UsageSplit } from "../../lib/usage.ts";
import { MemoryUsage } from "../memory-settings/memory-usage.tsx";
import { messages as memoryMessages } from "../memory-settings/messages.ts";
import { Page } from "../shell/pages.tsx";
import { DailyChart, HobBreakdown, QuestBreakdown } from "./hob-breakdown.tsx";
import { messages } from "./messages.ts";
import { alarmOf, ManageProviders, PlanBanner, PlanCardWaiting, PlanShelf, planViews } from "./plan-card.tsx";
import { WaysToSave } from "./ways-to-save.tsx";

const PERIODS = ["7", "30"] as const satisfies ReadonlyArray<UsagePeriod>;
const SPLITS = ["hob", "quest"] as const satisfies ReadonlyArray<UsageSplit>;

/** Each section's line icon, on a 16×16 grid in the label's color. */
const SECTION_ICONS = {
  daily: "M2.5 13.5h11M4.5 13.5v-4M8 13.5v-8M11.5 13.5v-6",
  hobs: "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M10.5 2.7a2.5 2.5 0 0 1 0 4.6M12 9.7c1.5.5 2.5 1.8 2.5 3.8",
  tips: "M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.1v.2h4v-.2c0-.4.2-.8.6-1.1A4.5 4.5 0 0 0 8 1.5z",
} as const;

/** A section of the page under a small label and its icon, with an optional control at its end. */
function Section({
  label,
  icon,
  extra,
  headingRef,
  children,
}: {
  label: string;
  icon?: keyof typeof SECTION_ICONS;
  extra?: React.ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="lbl m-0 flex items-center gap-1.5 text-meta text-label">
          {icon !== undefined && (
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={SECTION_ICONS[icon]} />
            </svg>
          )}
          {label}
        </h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** The period picker. The period lives in the URL (STD-REACT-002), so picking one navigates. */
function PeriodPicker({ days, by }: { days: UsagePeriod; by: UsageSplit }) {
  const navigate = useNavigate();
  return (
    <SegmentedControl
      aria-label={messages.period.label}
      value={days}
      onValueChange={(period: UsagePeriod) =>
        void navigate({ to: "/usage", search: { days: period === "30" ? 30 : 7, by: by === "quest" ? by : undefined } })
      }
    >
      {PERIODS.map((period) => (
        <SegmentedControlItem key={period} value={period}>
          {messages.period[period]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** By hob or By quest for Who used what. It lives in the URL beside the period. */
function SplitPicker({ days, by }: { days: UsagePeriod; by: UsageSplit }) {
  const navigate = useNavigate();
  return (
    <SegmentedControl
      aria-label={messages.split.label}
      size="sm"
      value={by}
      onValueChange={(split: UsageSplit) =>
        void navigate({
          to: "/usage",
          search: { days: days === "30" ? 30 : undefined, by: split === "quest" ? split : undefined },
        })
      }
    >
      {SPLITS.map((split) => (
        <SegmentedControlItem key={split} value={split}>
          {messages.split[split]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** Day by day's count of replies, then the key to its lit bar. */
function DailyLegend({ total }: { total: string | null }) {
  return (
    <span className="flex items-center gap-3 text-meta text-label">
      {total !== null && <span>{total}</span>}
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="size-2.5 rounded-[3px] bg-lantern" />
        {messages.daily.today}
      </span>
    </span>
  );
}

/** Who used what, by hob or by quest, with what the shares count. */
function WhoUsedWhat({
  days,
  counted,
  by,
  hobs,
  quests,
  looks,
}: {
  days: UsagePeriod;
  /** The period the shown report counts, which trails `days` while a new period loads. */
  counted: UsagePeriod;
  by: UsageSplit;
  /** Undefined until the report arrives. */
  hobs: ReadonlyArray<HobShare> | undefined;
  quests: ReadonlyArray<QuestUsage> | undefined;
  looks: ReadonlyMap<AgentId, Agent>;
}) {
  const period = messages.period.last[counted];
  return (
    <Section label={messages.hobs.label} icon="hobs" extra={<SplitPicker days={days} by={by} />}>
      {by === "quest"
        ? quests && <QuestBreakdown quests={questShares(quests)} period={period} />
        : hobs && <HobBreakdown hobs={hobs} looks={looks} period={period} />}
      <p className="m-0 text-meta text-label">{by === "quest" ? messages.quests.note : messages.note}</p>
    </Section>
  );
}

/**
 * The banner when a plan is low or used up, then Your AI with each provider's plan. The plans come
 * from the providers and can take seconds, so until they arrive Claude Code's card waits at its full
 * size, apart from the hub's own numbers below it.
 */
function YourAi({ onSave }: { onSave: () => void }) {
  const runtimes = useQuery(runtimesQuery);
  const plans = useQuery(plansQuery);
  const waiting = runtimes.isPending || plans.isPending || plans.isError;
  // A failed read says so until Try again asks again; then the wait line is back.
  const failed = plans.isError && !plans.isFetching;
  const wait = useWaitStage(waiting && !failed);
  const views = waiting ? undefined : planViews(runtimes.data ?? [], plans.data, new Date());
  const alarm = views && alarmOf(views);
  return (
    <>
      {alarm && <PlanBanner state={alarm} onSave={onSave} />}
      <Section label={messages.plans.label} extra={<ManageProviders />}>
        {views ? (
          <PlanShelf views={views} />
        ) : (
          <PlanCardWaiting runtimes={runtimes.data} wait={wait} failed={failed} onRetry={() => void plans.refetch()} />
        )}
      </Section>
    </>
  );
}

/** Day by day: the period's replies on each of the reader's days. */
function DayByDay({ report, days }: { report: UsageReport | undefined; days: UsagePeriod }) {
  const daily = report ? dailyUsage(report.minutes, report.until, Number(days)) : [];
  const replies = daily.reduce((sum, day) => sum + day.replies, 0);
  const total = report ? messages.daily.total({ count: replies, period: messages.period.last[days] }) : null;
  return (
    <Section label={messages.daily.label} icon="daily" extra={<DailyLegend total={total} />}>
      {report && <DailyChart days={daily} />}
    </Section>
  );
}

/** Screen 12, Usage: what's left of each AI plan and who used it, over 7 or 30 days (OP-002). */
export function UsagePage({ days, by }: { days: UsagePeriod; by: UsageSplit }) {
  const report = useQuery(usageQuery(days, localDay(new Date())));
  // While a new period loads, the last report stays on screen, named by the period it counts.
  const shown = report.data?.days ?? days;
  const active = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const tips = useRef<HTMLHeadingElement>(null);
  const looks = new Map<AgentId, Agent>(
    [...(active.data ?? []), ...(retired.data ?? [])].map((hob) => [hob.id, hob] as const),
  );
  const hobs = report.data && hobShares(report.data.hobs);
  // How to save brings its section into view and puts focus on its heading, so a keyboard follows too.
  const showTips = () => {
    tips.current?.scrollIntoView({ block: "start" });
    tips.current?.focus({ preventScroll: true });
  };

  return (
    <Page icon="Usage" title={messages.title} intro={messages.intro} actions={<PeriodPicker days={days} by={by} />}>
      {report.isError ? (
        <div className="flex items-center gap-3">
          <p className="m-0 text-rose">{messages.failed}</p>
          <Button variant="outline" size="xs" onClick={() => void report.refetch()}>
            {messages.retry}
          </Button>
        </div>
      ) : (
        <>
          <YourAi onSave={showTips} />
          <Section label={memoryMessages.usage.label}>
            <MemoryUsage />
          </Section>
          <DayByDay report={report.data} days={shown} />
          <WhoUsedWhat days={days} counted={shown} by={by} hobs={hobs} quests={report.data?.quests} looks={looks} />
          <Section label={messages.tips.label} icon="tips" headingRef={tips}>
            <WaysToSave busiest={hobs?.[0]} />
          </Section>
        </>
      )}
    </Page>
  );
}
