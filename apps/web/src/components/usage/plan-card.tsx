import {
  type PlanMeter,
  type PlanUsage,
  RUNTIME_NAMES,
  type RuntimeHealth,
  type RuntimeKind,
  unreportedPlan,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { Progress } from "@hobbots/ui/components/progress";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { POTION_COLORS, potion, potionPalette, UNREPORTED_POTION } from "../../art/icons.ts";
import { formatAgo, formatMoney } from "../../lib/format.ts";
import {
  billingOf,
  leftOf,
  meterLevel,
  type PlanLevel,
  planLevel,
  refillOf,
  reportedCredits,
} from "../../lib/usage.ts";
import { RuntimeTile } from "../providers/brain-picker.tsx";
import { messages } from "./messages.ts";
import { leftText, refillSentence, windowName } from "./plan-summary.ts";

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
interface PlanState {
  readonly level: PlanLevel;
  readonly tag: string;
  readonly banner: { readonly title: string; readonly line: string } | null;
}

/** What one provider's card says. Nothing is guessed: a plan that reported nothing says why. */
interface PlanView {
  readonly runtime: RuntimeKind;
  readonly name: string;
  readonly kind: string;
  /** How full the potion is, 0 to 1: what is left of the headline window. */
  readonly level: number;
  readonly palette: readonly [string, string];
  /** The headline window's name under the potion, or null when nothing was reported. */
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

/** What a provider's card shows, from its health and the plan it reported. */
const planView = (health: RuntimeHealth, plan: PlanUsage, now: Date): PlanView => {
  const name = RUNTIME_NAMES[health.runtime];
  const kind = health.availability === "ready" ? KIND[billingOf(health.billing)] : copy.unavailable;
  // The potion and the big number follow the window that sets the plan's level.
  const meter = planLevel(plan)?.meter;
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
      level: 0,
      palette: UNREPORTED_POTION,
      caption: null,
      headline: health.availability === "ready" ? copy.notReported : copy.unavailable,
      summary: kind,
      unreported: unreportedDetail(health, name),
      windows: [],
    };
  }
  return {
    ...base,
    level: leftOf(meter),
    palette: POTION_COLORS[health.runtime],
    caption: windowName(meter),
    headline: leftText(meter),
    summary:
      meter.resetsAt === null ? kind : `${kind} · ${copy.refillShort(refillOf(meter.resetsAt, now), meter.resetsAt)}`,
    unreported: null,
    windows: plan.meters.map(windowOf(now)),
  };
};

const TONE = { ok: "default", low: "low", out: "out" } as const;

// A tile's big number takes its plan's color once it is low or out.
const HEADLINE = { ok: "", low: "text-lantern", out: "text-rose" } as const;

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
        <strong className="text-text-strong">{window.left}</strong>
      </span>
      <Progress value={window.used} tone={TONE[window.level]} aria-hidden />
      <span className="text-detail text-label">{window.refill}</span>
    </li>
  );
}

/** One provider's plan: its potion beside each window in words, or why it shows none. */
function PlanCard({ view }: { view: PlanView }) {
  return (
    <section
      aria-label={copy.plan({ name: view.name })}
      className="cut flex animate-hb-in flex-wrap items-stretch gap-7 bg-card px-6 py-[22px] shadow-[inset_0_0_0_1px_var(--color-line)]"
    >
      <div className="flex w-[88px] shrink-0 flex-col items-center gap-2" aria-hidden>
        <PixelArt rows={potion(view.level)} palette={potionPalette(...view.palette)} size={72} />
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

const BANNER_EDGE = {
  low: "shadow-[inset_0_0_0_1px_var(--color-lantern)]",
  out: "shadow-[inset_0_0_0_1px_var(--color-rose)]",
};
const BANNER_GLYPH = { low: "bg-lantern text-on-lantern", out: "bg-rose text-on-rose" };

/** What happens while a plan is low or used up, and when it comes back. */
function PlanBanner({ level, title, line }: { level: "low" | "out"; title: string; line: string }) {
  return (
    <div
      role="status"
      className={cn("cut flex animate-hb-in items-center gap-3.5 bg-card py-3 ps-3 pe-3.5", BANNER_EDGE[level])}
    >
      <span
        aria-hidden
        className={cn("grid size-8 shrink-0 place-items-center rounded-dot font-bold", BANNER_GLYPH[level])}
      >
        {level === "low" ? "◷" : "!"}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="text-text-strong">{title}</strong>
        <span className="text-detail text-text-secondary">{line}</span>
      </span>
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
        "flex min-w-0 cursor-pointer flex-col items-stretch gap-2 rounded-control border-0 p-3 text-start text-text-strong transition-colors",
        // Selection is a fill, never an edge.
        on ? "bg-line" : "bg-card hover:bg-hover",
      )}
    >
      <span className="flex items-center gap-2">
        <RuntimeTile runtime={view.runtime} />
        <span className="truncate font-semibold">{view.name}</span>
      </span>
      <span className="flex items-end gap-2.5">
        <PixelArt rows={potion(view.level)} palette={potionPalette(...view.palette)} size={28} />
        <span className="flex min-w-0 flex-col">
          <strong className={cn("text-[15px]", view.state && HEADLINE[view.state.level])}>{view.headline}</strong>
          <span className="truncate text-meta text-label">{view.summary}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * Every connected provider's plan. With one, its card; with several, a row of tiles on top, and
 * picking one shows its card.
 */
export function PlanShelf({
  runtimes,
  plans,
  now,
}: {
  runtimes: ReadonlyArray<RuntimeHealth>;
  plans: ReadonlyArray<PlanUsage> | undefined;
  now: Date;
}) {
  const [picked, setPicked] = useState<RuntimeKind | null>(null);
  // Claude Code always has a card; another provider has one once it is connected.
  const views = runtimes
    .filter((health) => health.runtime === "claude-code" || health.availability === "ready")
    .map((health) =>
      planView(health, plans?.find((plan) => plan.runtime === health.runtime) ?? unreportedPlan(health.runtime), now),
    );
  const current = views.find((view) => view.runtime === picked) ?? views[0];
  if (current === undefined) return null;
  const alarm = views.find((view) => view.state?.level === "out") ?? views.find((view) => view.state?.level === "low");
  return (
    <>
      {alarm?.state?.banner && alarm.state.level !== "ok" && (
        <PlanBanner level={alarm.state.level} title={alarm.state.banner.title} line={alarm.state.banner.line} />
      )}
      {views.length > 1 && (
        <fieldset
          aria-label={copy.picker}
          className="m-0 grid min-w-0 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5 border-0 p-0"
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
      <PlanCard key={current.runtime} view={current} />
    </>
  );
}

/** The Usage screen's link to Settings, where providers are connected and fixed. */
export function ManageProviders() {
  return (
    <Link
      to="/settings/$section"
      params={{ section: "connections" }}
      className="text-detail text-text-secondary hover:text-text-strong hover:decoration-current"
    >
      {copy.manage}
    </Link>
  );
}
