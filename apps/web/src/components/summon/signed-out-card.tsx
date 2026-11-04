import type { RuntimeHealth } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { runtimesQuery } from "../../api/queries.ts";
import { PROVIDER_NAMES } from "../../lib/providers.ts";
import { providerFix } from "../provider-fix.tsx";
import { messages } from "./messages.ts";

const copy = messages.ready;

/**
 * The blocker on Ready when the AI the hob would think with is signed out: what is wrong, how to
 * sign in, and Check again, which needs no restart. Nothing the user picked is lost, and the card
 * goes away by itself once the hub sees the provider signed in.
 */
export function SignedOutCard({ health, name }: { health: RuntimeHealth; name: string }) {
  const runtimes = useQuery(runtimesQuery);
  const provider = PROVIDER_NAMES[health.runtime];
  return (
    <section
      role="alert"
      aria-label={copy.signedOut({ provider })}
      className="flex flex-col gap-2 rounded-card border-(length:--edge) border-rose bg-card px-4 py-3.5"
    >
      <span className="flex items-center gap-3">
        <strong className="min-w-0 flex-1">{copy.signedOut({ provider })}</strong>
        <Badge variant="failed">{copy.needsFix}</Badge>
      </span>
      <p className="m-0 text-sm leading-5">{copy.signedOutWhy({ provider, name })}</p>
      <p className="m-0 text-detail text-text-secondary [&_code]:font-mono [&_code]:text-text-strong">
        {providerFix(health.runtime, health)}
      </p>
      <span className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={() => void runtimes.refetch()} disabled={runtimes.isFetching}>
          {runtimes.isFetching ? copy.checking : copy.checkAgain}
        </Button>
        <Button asChild variant="ghost" className="text-text-secondary">
          <Link to="/settings/$section" params={{ section: "connections" }}>
            {copy.openSettings}
          </Link>
        </Button>
      </span>
    </section>
  );
}
