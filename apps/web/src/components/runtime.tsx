import { Badge } from "@hobbots/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { runtimesQuery } from "../api/queries.ts";

const useClaudeRuntime = () => {
  const runtimes = useQuery(runtimesQuery);
  return { pending: runtimes.isPending, claude: runtimes.data?.[0] };
};

const ProviderTile = () => (
  <span aria-hidden className="grid size-5 place-items-center bg-[#e39a74] text-xs font-bold text-ground">
    C
  </span>
);

/** The brain chip in the chat header: which provider runs this hob, and whether it is ready. */
export function RuntimeChip() {
  const { pending, claude } = useClaudeRuntime();
  const ready = claude?.availability === "ready";
  return (
    <span className="flex flex-none items-center gap-2 border-2 border-line-2 px-2 py-1 text-xs whitespace-nowrap">
      <ProviderTile />
      <span className="font-bold">Claude Code</span>
      <span className={ready ? "text-mint" : "text-lantern"}>
        {pending ? "checking" : ready ? "ready" : (claude?.availability ?? "unknown")}
      </span>
    </span>
  );
}

/** Provider health for the Workshop tab. Detail is never shown: it can carry account names. */
export function RuntimeCard() {
  const { pending, claude } = useClaudeRuntime();
  const onSubscription = claude?.billing?.startsWith("subscription") ?? false;
  const warnBilling = claude?.availability === "ready" && !onSubscription && claude.billing !== "fake";

  return (
    <div className="cut bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <ProviderTile />
        <span className="font-pixel flex-1 text-base font-semibold">Claude Code</span>
        <Badge variant={claude?.availability === "ready" ? "working" : "waiting"}>
          {pending ? "Checking" : claude?.availability === "ready" ? "Ready" : "Unavailable"}
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
      {warnBilling && (
        <p className="mt-2 mb-0 text-sm text-lantern">
          Not billing your Claude subscription. Unset ANTHROPIC_API_KEY and sign in to Claude Code with your claude.ai
          account.
        </p>
      )}
    </div>
  );
}
