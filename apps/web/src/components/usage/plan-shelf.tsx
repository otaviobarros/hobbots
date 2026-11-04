import {
  type PlanMeter,
  type PlanUsage,
  RUNTIME_NAMES,
  type RuntimeHealth,
  type RuntimeKind,
  unreportedPlan,
} from "@hobbots/domain";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { potion, potionPalette } from "../../art/icons.ts";
import { formatMoney } from "../../lib/format.ts";
import { billingOf, headlineMeter, leftOf, refillOf, reportedCredits } from "../../lib/usage.ts";
import { messages } from "./messages.ts";

const copy = messages.plans;

// Each provider's potion colors; a plan that reports nothing shows an empty grey bottle.
const POTION: Record<RuntimeKind, readonly [fill: string, top: string]> = {
  "claude-code": ["#e39a74", "#f3c4a8"],
  codex: ["#7fd1b9", "#b5ecd9"],
};
const UNREPORTED = ["#3a3666", "#3a3666"] as const;

/** What one provider's potion says: how full it is, its headline and the sentence under it. */
interface PlanView {
  readonly runtime: RuntimeKind;
  readonly name: string;
  readonly kind: string;
  readonly level: number;
  readonly palette: readonly [string, string];
  readonly headline: string;
  readonly detail: string;
  readonly meters: ReadonlyArray<PlanMeter>;
  readonly credits: string | null;
}

const meterLabel = (meter: PlanMeter): string => {
  if (meter.kind === "session") return copy.meter.session;
  if (meter.kind === "weekly_all") return copy.meter.weekly_all;
  if (meter.kind === "weekly_scoped" && meter.scope !== null) return copy.meter.weekly_scoped({ scope: meter.scope });
  return copy.meter.other({ name: meter.scope ?? meter.group });
};

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

const KIND = { subscription: copy.subscription, apiKey: copy.apiKey, unknown: copy.connected } as const;

/** What a provider's potion shows, from its health and the plan it reported. Nothing is guessed. */
const planView = (health: RuntimeHealth, plan: PlanUsage, now: Date): PlanView => {
  const name = RUNTIME_NAMES[health.runtime];
  const kind = health.availability === "ready" ? KIND[billingOf(health.billing)] : copy.unavailable;
  const meter = plan.reported ? headlineMeter(plan) : undefined;
  if (meter === undefined) {
    return {
      runtime: health.runtime,
      name,
      kind,
      level: 0,
      palette: UNREPORTED,
      headline: health.availability === "ready" ? copy.notReported : copy.unavailable,
      detail: unreportedDetail(health, name),
      meters: [],
      credits: creditsOf(plan),
    };
  }
  return {
    runtime: health.runtime,
    name,
    kind,
    level: leftOf(meter),
    palette: POTION[health.runtime],
    headline: copy.left({ percent: Math.round(leftOf(meter) * 100) }),
    detail: meter.resetsAt === null ? copy.noRefill : copy.refill(refillOf(meter.resetsAt, now)),
    meters: plan.meters,
    credits: creditsOf(plan),
  };
};

// The provider's own reading of a meter colors its bar; Hobbots never grades one itself.
const SEVERITY: Record<string, string> = { warning: "bg-lantern", critical: "bg-rose" };

function Meter({ meter, now }: { meter: PlanMeter; now: Date }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap justify-between gap-x-3 text-[13px]">
        <span>{copy.meterUsed({ label: meterLabel(meter), percent: meter.percent })}</span>
        {meter.resetsAt !== null && (
          <span className="text-label">{copy.meterResets(refillOf(meter.resetsAt, now))}</span>
        )}
      </span>
      <span className="h-2.5 bg-line-2" aria-hidden="true">
        <span
          className={cn("block h-full", SEVERITY[meter.severity] ?? "bg-mint")}
          style={{ width: `${Math.min(100, Math.max(0, meter.percent))}%` }}
        />
      </span>
    </li>
  );
}

/** Every connected provider's potion on a shelf; picking one shows its meters beside the shelf. */
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
  // Claude Code always has a potion; another provider has one once it is connected.
  const views = runtimes
    .filter((health) => health.runtime === "claude-code" || health.availability === "ready")
    .map((health) =>
      planView(health, plans?.find((plan) => plan.runtime === health.runtime) ?? unreportedPlan(health.runtime), now),
    );
  const current = views.find((view) => view.runtime === picked) ?? views[0];
  if (current === undefined) return null;
  return (
    <div className="flex flex-wrap items-stretch gap-5">
      <div
        role="radiogroup"
        aria-label={copy.picker}
        className="flex items-end gap-1.5 border-b-[6px] border-wood px-1"
      >
        {views.map((view) => {
          const on = view.runtime === current.runtime;
          return (
            <label
              key={view.runtime}
              className={cn(
                "hop-on-hover flex cursor-pointer flex-col items-center gap-1 px-1.5 pt-2 pb-1.5 text-xs font-bold has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight",
                on ? "bg-line text-moonlight" : "text-text-secondary hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name="usage-plan"
                value={view.runtime}
                checked={on}
                onChange={() => setPicked(view.runtime)}
                aria-label={copy.potion({ name: view.name, state: view.headline })}
                className="sr-only"
              />
              <span className="sprite">
                <PixelArt rows={potion(view.level)} palette={potionPalette(...view.palette)} size={on ? 72 : 56} />
              </span>
              <span aria-hidden="true">{view.name}</span>
            </label>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 basis-[220px] animate-hb-in flex-col gap-2" aria-live="polite">
        <span className="text-sm text-text-secondary">
          {current.name} · {current.kind}
        </span>
        <span className="font-heading text-[34px] font-bold leading-none">{current.headline}</span>
        <span className="text-sm leading-snug text-text-secondary">{current.detail}</span>
        {current.meters.length > 1 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {current.meters.map((meter) => (
              <Meter key={`${meter.kind}-${meter.scope ?? ""}`} meter={meter} now={now} />
            ))}
          </ul>
        )}
        {current.credits !== null && <span className="text-[13px] text-text-secondary">{current.credits}</span>}
      </div>
    </div>
  );
}

/** The Usage screen's link to Settings, where providers are connected and fixed. */
export function ManageProviders() {
  return (
    <Link to="/settings" className="text-[13px]">
      {copy.manage}
    </Link>
  );
}
