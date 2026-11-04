import {
  type PlanMeter,
  type PlanUsage,
  RUNTIME_NAMES,
  type RuntimeHealth,
  type RuntimeKind,
  unreportedPlan,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Progress } from "@hobbots/ui/components/progress";
import { Skeleton, WaitNote } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import type { Wait } from "@hobbots/ui/lib/wait-stage";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatAgo, formatMoney } from "../../lib/format.ts";
import {
  billingOf,
  leftOf,
  meterLevel,
  type PlanLevel,
  planLevel,
  potionMeter,
  refillOf,
  reportedCredits,
} from "../../lib/usage.ts";
import { RuntimeTile } from "../providers/brain-picker.tsx";
import { messages } from "./messages.ts";
import { leftText, refillSentence, windowName } from "./plan-summary.ts";
import { PotionBottle, type PotionFill, PotionVial } from "./potion.tsx";

const copy = messages.plans;

/** One of a plan's windows, in words: what it is, how much is used and when it refills. */
interface PlanWindow {
  readonly key: string;
  readonly label: string;
  /** How much of the window is used, 0 to 100. */
  readonly used: number;
  readonly level: PlanLevel;
  readonly left: string;
  readonly refill: string;
}

/** A plan's state tag and the banner it raises when it is low or out. */
export interface PlanState {
  readonly level: PlanLevel;
  readonly tag: string;
  readonly banner: { readonly title: string; readonly line: string } | null;
}

/** What one provider's card says. Nothing is guessed: a plan that reported nothing says why. */
export interface PlanView {
  readonly runtime: RuntimeKind;
  readonly name: string;
  readonly kind: string;
  /** How full the potion is and in what tone, from the week's window; null for an empty bottle. */
  readonly potion: PotionFill | null;
  /** The potion's window under it, or null when nothing was reported. */
  readonly caption: string | null;
  /** The big number on the provider's tile: "62% left", or Not reported. */
  readonly headline: string;
  /** The tile's second line: how the plan bills and when the headline window refills. */
  readonly summary: string;
  /** Why the plan shows no windows, when it reported none. */
  readonly unreported: string | null;
  readonly windows: ReadonlyArray<PlanWindow>;
  readonly credits: string | null;
  readonly checked: string | null;
  /** Null when the plan reported no window. */
  readonly state: PlanState | null;
}

const windowOf =
  (now: Date) =>
  (meter: PlanMeter): PlanWindow => ({
    key: `${meter.kind}-${meter.scope ?? ""}`,
    label: windowName(meter),
    used: Math.min(100, Math.max(0, meter.percent)),
    level: meterLevel(meter),
    left: leftText(meter),
    refill: refillSentence(meter.resetsAt, now),
  });

const creditsOf = (plan: PlanUsage): string | null => {
  const spent = reportedCredits(plan);
  if (spent === null) return null;
  return copy.credits({
    used: formatMoney(spent.used, spent.currency),
    limit: spent.limit === null ? null : formatMoney(spent.limit, spent.currency),
  });
};

const unreportedDetail = (health: RuntimeHealth, name: string): string => {
  if (health.availability !== "ready") return copy.notConnected({ name });
  const billing = billingOf(health.billing);
  if (billing === "subscription") return copy.subscriptionUnreported({ name });
  if (billing === "apiKey") return copy.apiKeyUnreported({ name });
  return copy.unknownUnreported({ name });
};

/** The plan's tag, and a banner when it is low or out, from the window that sets its level. */
const stateOf = (plan: PlanUsage, name: string, now: Date): PlanState | null => {
  const worst = planLevel(plan);
  if (worst === undefined) return null;
  const { level, meter } = worst;
  const window = windowName(meter);
  if (level === "ok") return { level, tag: copy.state.ok, banner: null };
  if (level === "low") {
    return {
      level,
      tag: copy.state.low,
      banner: {
        title: copy.banner.low({ name, window }),
        line: copy.banner.lowLine({ left: leftText(meter), refill: refillSentence(meter.resetsAt, now) }),
      },
    };
  }
  const refill = meter.resetsAt === null ? null : refillOf(meter.resetsAt, now);
  return {
    level,
    tag: copy.state.out(refill, meter.resetsAt),
    banner: {
      title: copy.banner.out,
      line: copy.banner.outLine({ name, window, refill: refillSentence(meter.resetsAt, now) }),
    },
  };
};

const KIND = { subscription: copy.subscription, apiKey: copy.apiKey, unknown: copy.connected } as const;

/** How a provider's plan bills, in words, or Not connected. */
const kindOf = (health: RuntimeHealth): string =>
  health.availability === "ready" ? KIND[billingOf(health.billing)] : copy.unavailable;

/** What a provider's card shows, from its health and the plan it reported. */
const planView = (health: RuntimeHealth, plan: PlanUsage, now: Date): PlanView => {
  const name = RUNTIME_NAMES[health.runtime];
  const kind = kindOf(health);
  // The big number follows the window that sets the plan's level; the potion shows the week.
  const meter = planLevel(plan)?.meter;
  const week = potionMeter(plan);
  const base = {
    runtime: health.runtime,
    name,
    kind,
    credits: creditsOf(plan),
    checked: plan.checkedAt === null ? null : copy.checked({ name, ago: formatAgo(plan.checkedAt, now) }),
    state: stateOf(plan, name, now),
  };
  if (meter === undefined) {
    return {
      ...base,
      potion: null,
      caption: null,
      headline: health.availability === "ready" ? copy.notReported : copy.unavailable,
      summary: kind,
      unreported: unreportedDetail(health, name),
      windows: [],
    };
  }
  return {
    ...base,
    potion: week === undefined ? null : { left: leftOf(week), level: meterLevel(week) },
    caption: week === undefined ? null : windowName(week),
    headline: leftText(meter),
    summary:
      meter.resetsAt === null ? kind : `${kind} · ${copy.refillShort(refillOf(meter.resetsAt, now), meter.resetsAt)}`,
    unreported: null,
    windows: plan.meters.map(windowOf(now)),
  };
};

const TONE = { ok: "default", low: "low", out: "out" } as const;

// A number of what is left takes its window's tone: mint, lantern when low, rose when used up. Each
// sits on `card`, where all three meet the text floor in every theme.
const LEFT = { ok: "text-mint", low: "text-lantern", out: "text-rose" } as const;

const TAG = { ok: "done", low: "needs-you", out: "failed" } as const;

function StateTag({ state }: { state: PlanState }) {
  return (
    <Badge variant={TAG[state.level]}>
      {state.level === "ok" && <span data-slot="badge-glyph">✓</span>}
      {state.tag}
    </Badge>
  );
}

function Window({ window }: { window: PlanWindow }) {
  return (
    <li className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="flex-1 text-text">{window.label}</span>
        <strong className={LEFT[window.level]}>{window.left}</strong>
      </span>
      <Progress value={window.used} tone={TONE[window.level]} aria-hidden />
      <span className="text-detail text-label">{window.refill}</span>
    </li>
  );
}

const CARD = "cut flex flex-wrap items-stretch gap-7 bg-card px-6 py-[22px] shadow-[inset_0_0_0_1px_var(--color-line)]";

/**
 * One provider's plan: its potion beside each window in words, or why it shows none. It rises in
 * only when picked from the tiles: the first card takes the waiting card's place without moving.
 */
function PlanCard({ view, picked }: { view: PlanView; picked: boolean }) {
  return (
    <section aria-label={copy.plan({ name: view.name })} className={cn(CARD, picked && "animate-hb-in")}>
      <div className="flex w-[88px] shrink-0 flex-col items-center gap-2" aria-hidden>
        <PotionBottle fill={view.potion} />
        {view.caption !== null && <span className="text-meta text-label">{view.caption}</span>}
      </div>
      <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-3.5">
        <span className="flex items-center gap-2.5">
          <RuntimeTile runtime={view.runtime} />
          <strong className="flex-1 text-text-strong">
            {view.name} · {view.kind}
          </strong>
          {view.state && <StateTag state={view.state} />}
        </span>
        {view.unreported !== null && (
          <span className="flex flex-col gap-1">
            <strong className="font-heading text-title text-text-strong">{view.headline}</strong>
            <span className="text-detail text-text-secondary">{view.unreported}</span>
          </span>
        )}
        {view.windows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
            {view.windows.map((window) => (
              <Window key={window.key} window={window} />
            ))}
          </ul>
        )}
        {view.credits !== null && <span className="text-detail text-text-secondary">{view.credits}</span>}
        {view.checked !== null && <span className="text-detail text-text-secondary">{view.checked}</span>}
      </div>
    </section>
  );
}

const BANNER = {
  low: "[--banner:var(--color-lantern)]",
  out: "[--banner:var(--color-rose)]",
} as const;

/**
 * What happens while a plan is low or used up, and when it comes back, with How to save. It sits
 * above the page's sections, tinted with the plan's tone.
 */
export function PlanBanner({ state, onSave }: { state: PlanState; onSave: () => void }) {
  if (state.banner === null || state.level === "ok") return null;
  return (
    <div
      role="status"
      className={cn(
        "cut flex animate-hb-in flex-wrap items-center gap-3.5 py-3 ps-3 pe-3.5",
        "bg-[color-mix(in_srgb,var(--banner)_10%,var(--color-card))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--banner)_45%,transparent)]",
        BANNER[state.level],
      )}
    >
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-dot bg-[color-mix(in_srgb,var(--banner)_22%,transparent)] font-bold text-text-strong"
      >
        {state.level === "low" ? "◷" : "!"}
      </span>
      <span className="flex min-w-0 flex-1 basis-[260px] flex-col">
        <strong className="text-text-strong">{state.banner.title}</strong>
        <span className="text-detail text-text-secondary">{state.banner.line}</span>
      </span>
      <Button variant="outline" size="sm" onClick={onSave}>
        {copy.save}
      </Button>
    </div>
  );
}

/** A provider's tile in the row above the card: its mark, a small potion, the big number and one line. */
function ProviderTile({ view, on, onPick }: { view: PlanView; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col items-stretch gap-2 rounded-control border-0 bg-card p-3 text-start text-text-strong transition-colors hover:bg-hover",
        // The picked tile carries the focus-ring edge; its fill stays `card`, so its number keeps its floor.
        on && "shadow-[inset_0_0_0_2px_var(--color-focus-ring)]",
      )}
    >
      <span className="flex items-center gap-2">
        <RuntimeTile runtime={view.runtime} />
        <span className="truncate font-semibold">{view.name}</span>
      </span>
      <span className="flex items-end gap-2.5">
        <PotionVial fill={view.potion} />
        <span className="flex min-w-0 flex-col">
          <strong className={cn("text-body", view.state && LEFT[view.state.level])}>{view.headline}</strong>
          <span className="truncate text-meta text-label">{view.summary}</span>
        </span>
      </span>
    </button>
  );
}

/** The providers with a card: Claude Code always, another provider once it is connected. */
const withCards = (runtimes: ReadonlyArray<RuntimeHealth>): ReadonlyArray<RuntimeHealth> =>
  runtimes.filter((health) => health.runtime === "claude-code" || health.availability === "ready");

/** Each connected provider's card. Claude Code always has one; another provider once it is connected. */
export const planViews = (
  runtimes: ReadonlyArray<RuntimeHealth>,
  plans: ReadonlyArray<PlanUsage> | undefined,
  now: Date,
): ReadonlyArray<PlanView> =>
  withCards(runtimes).map((health) =>
    planView(health, plans?.find((plan) => plan.runtime === health.runtime) ?? unreportedPlan(health.runtime), now),
  );

/** The plan whose banner the page shows: one used up first, else one running low. */
export const alarmOf = (views: ReadonlyArray<PlanView>): PlanState | undefined =>
  (views.find((view) => view.state?.level === "out") ?? views.find((view) => view.state?.level === "low"))?.state ??
  undefined;

/**
 * Every connected provider's plan. With one, its card; with several, a row of tiles that shares the
 * column's width on top, and picking one shows its card.
 */
export function PlanShelf({ views }: { views: ReadonlyArray<PlanView> }) {
  const [picked, setPicked] = useState<RuntimeKind | null>(null);
  const current = views.find((view) => view.runtime === picked) ?? views[0];
  if (current === undefined) return null;
  return (
    <>
      {views.length > 1 && (
        <fieldset
          aria-label={copy.picker}
          className="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5 border-0 p-0"
        >
          {views.map((view) => (
            <ProviderTile
              key={view.runtime}
              view={view}
              on={view.runtime === current.runtime}
              onPick={() => setPicked(view.runtime)}
            />
          ))}
        </fieldset>
      )}
      <PlanCard key={current.runtime} view={current} picked={picked !== null} />
    </>
  );
}

/** A window's place while the plan is asked for: its label, what is left, the empty track and the refill line. */
function WindowWaiting({ label, refill }: { label: string; refill: string }) {
  return (
    <li className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="flex-1">
          <Skeleton surface="card" width={label} />
        </span>
        <strong>
          <Skeleton surface="card" width="7ch" />
        </strong>
      </span>
      <Skeleton shape="bar" />
      <span className="text-detail">
        <Skeleton surface="card" width={refill} />
      </span>
    </li>
  );
}

/** A provider's tile while the plans are asked for: its mark and name, an empty vial and two blocks. */
function ProviderTileWaiting({ health, on }: { health: RuntimeHealth; on: boolean }) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-col items-stretch gap-2 rounded-control bg-card p-3 text-text-strong",
        on && "shadow-[inset_0_0_0_2px_var(--color-focus-ring)]",
      )}
    >
      <span className="flex items-center gap-2">
        <RuntimeTile runtime={health.runtime} />
        <span className="truncate font-semibold">{RUNTIME_NAMES[health.runtime]}</span>
      </span>
      <span aria-hidden className="flex items-end gap-2.5">
        <PotionVial fill={null} />
        <span className="flex min-w-0 flex-col">
          <strong className="text-body">
            <Skeleton surface="card" width="8ch" />
          </strong>
          <span className="text-meta">
            <Skeleton surface="card" width="14ch" />
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * Claude Code's card while its plan is asked for (Patterns › Loading), drawn at the loaded card's
 * size so nothing moves when the plan lands: the empty potion, the provider's mark and name, a tag
 * block and two windows of blocks, under a row of waiting tiles when several providers are connected. Its wait line stands where the loaded card says when the numbers
 * were checked. A failed read says so in the same place, with Try again.
 */
export function PlanCardWaiting({
  runtimes,
  wait,
  failed,
  onRetry,
}: {
  /** The providers' health, once it is known: it names how Claude Code bills and which tiles show. */
  runtimes: ReadonlyArray<RuntimeHealth> | undefined;
  wait: Wait;
  failed: boolean;
  onRetry: () => void;
}) {
  const name = RUNTIME_NAMES["claude-code"];
  const shown = runtimes === undefined ? [] : withCards(runtimes);
  const claude = shown.find((health) => health.runtime === "claude-code");
  const kind = claude === undefined ? null : kindOf(claude);
  return (
    <>
      {shown.length > 1 && (
        <div aria-hidden className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
          {shown.map((health, index) => (
            <ProviderTileWaiting key={health.runtime} health={health} on={index === 0} />
          ))}
        </div>
      )}
      <section aria-label={copy.plan({ name })} aria-busy={!failed} className={CARD}>
        <div className="flex w-[88px] shrink-0 flex-col items-center gap-2" aria-hidden>
          <PotionBottle fill={null} />
          <span className="text-meta">
            <Skeleton surface="card" width="9ch" />
          </span>
        </div>
        <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-3.5">
          <span className="flex items-center gap-2.5">
            <RuntimeTile runtime="claude-code" />
            <strong className="flex-1 text-text-strong">
              {name}
              {kind !== null && ` · ${kind}`}
            </strong>
            <Skeleton shape="block" surface="card" width="11ch" />
          </span>
          <ul aria-hidden className="m-0 flex list-none flex-col gap-3.5 p-0">
            <WindowWaiting label="12ch" refill="30ch" />
            <WindowWaiting label="9ch" refill="26ch" />
          </ul>
          {failed ? (
            <span className="flex min-h-lh flex-wrap items-center gap-x-2 text-detail">
              <span className="text-rose">{copy.failed({ name })}</span>
              <Button variant="ghost" size="xs" onClick={onRetry}>
                {messages.retry}
              </Button>
            </span>
          ) : (
            <WaitNote
              className="min-h-lh"
              wait={wait}
              detail={copy.asking({ name })}
              outside={{ note: copy.slow({ name }), retryLabel: messages.retry, onRetry }}
            />
          )}
        </div>
      </section>
    </>
  );
}

/** The Usage screen's way to Settings, where providers are connected and fixed: a quiet button. */
export function ManageProviders() {
  return (
    <Button asChild variant="ghost" size="xs">
      <Link to="/settings/$section" params={{ section: "connections" }}>
        {copy.manage}
      </Link>
    </Button>
  );
}
