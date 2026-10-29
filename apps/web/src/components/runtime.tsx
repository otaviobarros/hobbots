import type { RuntimeHealth } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { runtimesQuery } from "../api/queries.ts";
import { claudeInstallGuide, runtimeProblem } from "../api/runtime-health.ts";

const useClaudeRuntime = () => {
  const runtimes = useQuery(runtimesQuery);
  return {
    pending: runtimes.isPending,
    checking: runtimes.isFetching,
    claude: runtimes.data?.[0],
    checkAgain: () => void runtimes.refetch(),
  };
};

const ProviderTile = () => (
  <span aria-hidden className="grid size-5 place-items-center bg-[#e39a74] text-xs font-bold text-ground">
    C
  </span>
);

const availabilityLabel: Record<RuntimeHealth["availability"], string> = {
  ready: "Ready",
  outdated: "Outdated",
  signedOut: "Signed out",
  unavailable: "Unavailable",
  unverified: "Unverified",
};

/** The brain chip in the chat header: which provider runs this hob, and whether it is ready. */
export function RuntimeChip() {
  const { pending, claude } = useClaudeRuntime();
  const ready = claude?.availability === "ready";
  return (
    <span className="flex flex-none items-center gap-2 border-2 border-line-2 px-2 py-1 text-xs whitespace-nowrap">
      <ProviderTile />
      <span className="font-bold">Claude Code</span>
      <span className={ready ? "text-mint" : "text-lantern"}>
        {pending ? "checking" : claude ? availabilityLabel[claude.availability].toLowerCase() : "unknown"}
      </span>
    </span>
  );
}

/** Provider health for the Workshop tab. Detail is never shown: it can carry account names. */
export function RuntimeCard() {
  const { pending, checking, claude, checkAgain } = useClaudeRuntime();
  const problem = runtimeProblem(claude);
  const onSubscription = claude?.billing?.startsWith("subscription") ?? false;
  const warnBilling = claude?.availability === "ready" && !onSubscription && claude.billing !== "fake";

  return (
    <div className="cut bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <ProviderTile />
        <span className="font-pixel flex-1 text-base font-semibold">Claude Code</span>
        <Badge variant={claude?.availability === "ready" ? "working" : "waiting"}>
          {pending ? "Checking" : availabilityLabel[claude?.availability ?? "unavailable"]}
        </Badge>
      </div>
      {claude && (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-label">Billing</dt>
          <dd className={warnBilling ? "m-0 text-lantern" : "m-0"}>{claude.billing ?? "—"}</dd>
          <dt className="text-label">Version</dt>
          <dd className="m-0">{claude.version ?? "—"}</dd>
        </dl>
      )}
      {problem === "outdated" && (
        <p className="mt-2 mb-0 text-sm text-lantern">
          This Claude Code is older than Hobbots supports. Update it with <code>claude update</code>.
        </p>
      )}
      {problem === "notFound" && (
        <p className="mt-2 mb-0 text-sm text-lantern">
          Claude Code was not found or could not start. Install it and sign in with <code>claude</code>.
        </p>
      )}
      {problem === "signedOut" && (
        <p className="mt-2 mb-0 text-sm text-lantern">
          Claude Code is installed but not signed in. Run <code>claude</code> in a terminal and sign in with your
          claude.ai account.
        </p>
      )}
      {problem === "notStarted" && (
        <p className="mt-2 mb-0 text-sm text-lantern">
          Claude Code is installed but did not start. Run <code>claude</code> in a terminal to sign in.
        </p>
      )}
      {problem !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {problem === "notFound" && (
            <Button asChild variant="outline" size="sm">
              <a href={claudeInstallGuide} target="_blank" rel="noreferrer">
                Install guide
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={checkAgain} disabled={checking}>
            {checking ? "Looking on this Mac…" : "Check again"}
          </Button>
          <span className="text-xs text-label">No need to restart Hobbots.</span>
        </div>
      )}
      {warnBilling && (
        <p className="mt-2 mb-0 text-sm text-lantern">
          Not billing your Claude subscription. Unset ANTHROPIC_API_KEY and sign in to Claude Code with your claude.ai
          account.
        </p>
      )}
    </div>
  );
}
