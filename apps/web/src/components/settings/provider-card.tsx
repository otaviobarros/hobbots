import { RUNTIME_NAMES, type RuntimeHealth, type RuntimeKind } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { runtimesQuery } from "../../api/queries.ts";
import { PROVIDER_MARKS } from "../../lib/providers.ts";
import { EnforcementList } from "../hob-profile/enforcement.tsx";
import { messages as sharedMessages } from "../messages.ts";
import { ProviderFixActions, providerFix } from "../providers/provider-fix.tsx";
import { messages } from "./messages.ts";

const copy = messages.providers;

/** Claude Code that bills an API key instead of the user's subscription, which costs them extra. */
const billsElsewhere = (health: RuntimeHealth | undefined) =>
  health?.runtime === "claude-code" &&
  health.availability === "ready" &&
  !(health.billing?.startsWith("subscription") ?? false) &&
  health.billing !== "fake";

function ProviderFacts({ health }: { health: RuntimeHealth }) {
  return (
    <>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-label">{copy.billing}</dt>
        <dd className={billsElsewhere(health) ? "m-0 text-lantern" : "m-0"}>{health.billing ?? "—"}</dd>
        <dt className="text-label">{copy.version}</dt>
        <dd className="m-0">{health.version ?? "—"}</dd>
      </dl>
      <h4 className="lbl mt-3 mb-1.5 text-xs text-label">{sharedMessages.enforcement.providerHeading}</h4>
      <EnforcementList enforcement={health.enforcement} />
    </>
  );
}

/**
 * One provider's health in Settings › AI providers, with how to fix it when it cannot think.
 * Detail is never shown: it can carry account names.
 */
export function ProviderCard({ runtime }: { runtime: RuntimeKind }) {
  const runtimes = useQuery(runtimesQuery);
  const health = runtimes.data?.find((entry) => entry.runtime === runtime);
  const name = RUNTIME_NAMES[runtime];
  const look = PROVIDER_MARKS[runtime];
  const hint = providerFix(runtime, health);
  const availability = health?.availability ?? "unavailable";

  return (
    <section aria-label={name} className="flex flex-col gap-2.5 rounded-card bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={`grid size-7 flex-none place-items-center rounded-tile text-detail font-bold text-provider-ink ${look.tile}`}
        >
          {look.mark}
        </span>
        <span className="flex-1 font-semibold text-text-strong">{name}</span>
        <Badge variant={availability === "ready" ? "working" : "waiting"}>
          {runtimes.isPending ? copy.checking : copy.availability[availability]}
        </Badge>
      </div>
      {hint && <p className="m-0 text-sm text-lantern">{hint}</p>}
      {hint && <ProviderFixActions runtime={runtime} notFound={health?.version === null} className="mt-0" />}
      {billsElsewhere(health) && <p className="m-0 text-sm text-lantern">{copy["claude-code"].billingWarning}</p>}
      {health && (
        <details className="group">
          <summary className="cursor-pointer text-detail text-label hover:text-text-strong">{copy.technical}</summary>
          <div className="pt-2.5">
            <ProviderFacts health={health} />
          </div>
        </details>
      )}
    </section>
  );
}
