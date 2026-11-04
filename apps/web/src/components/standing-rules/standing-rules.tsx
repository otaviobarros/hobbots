import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { grantsQuery } from "../../api/grants.ts";
import { agentsQuery } from "../../api/queries.ts";
import { HubWait, ROW_WIDTHS, SKELETON_ROWS } from "../loading/hub-wait.tsx";
import { messages } from "./messages.ts";
import { StandingRuleRow } from "./standing-rule-row.tsx";
import { standingRules } from "./standing-rules.ts";

const copy = messages;

/**
 * Every "Always" rule that applies now, of every hob (ADR 015): what it allows, for which hob, when
 * it was saved and last used, and the request that saved it. Each can be removed, after asking.
 * Inbox History and Settings › Permissions show the same list.
 */
function StandingRuleList({ surface }: { surface: "plain" | "card" }) {
  const grants = useQuery(grantsQuery);
  const hobs = useQuery(agentsQuery);
  if (grants.isPending) return <RulesSkeleton surface={surface} onRetry={() => void grants.refetch()} />;
  if (grants.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-ui text-rose">
        {copy.failed}
        <Button variant="outline" onClick={() => void grants.refetch()}>
          {copy.retry}
        </Button>
      </div>
    );
  }
  const rules = standingRules(grants.data);
  if (rules.length === 0) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="font-bold">{copy.empty}</span>
        <span className="text-ui text-text-secondary">{copy.emptyHint}</span>
      </div>
    );
  }
  return (
    <ul aria-label={copy.heading} className="m-0 flex list-none flex-col p-0">
      {rules.map((grant) => (
        <StandingRuleRow key={grant.id} grant={grant} hob={hobs.data?.find((hob) => hob.id === grant.agentId)} />
      ))}
    </ul>
  );
}

/** Three rule rows while the rules are read: a tile, the rule and its dates in skeleton. */
function RulesSkeleton({ surface, onRetry }: { surface: "plain" | "card"; onRetry: () => void }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 pb-2">
      <ul aria-hidden className="m-0 flex list-none flex-col p-0">
        {SKELETON_ROWS.map((row) => (
          <li key={row} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
            <Skeleton shape="tile" surface={surface} className="size-5.5" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-ui">
                <Skeleton surface={surface} width={ROW_WIDTHS[row]} className="max-w-full" />
              </span>
              <span className="text-meta">
                <Skeleton surface={surface} width="20ch" className="max-w-full" />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <HubWait pending onRetry={onRetry} />
    </div>
  );
}

/** The standing rules at the top of Inbox History, above the decisions. */
export function StandingRules() {
  const grants = useQuery(grantsQuery);
  const count = grants.data === undefined ? undefined : standingRules(grants.data).length;
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2.5">
      <h2 className="m-0 flex items-center gap-2 text-ui font-semibold text-text-strong">
        {copy.history.title}
        {grants.isPending && <Skeleton width="1ch" />}
        {count !== undefined && <span className="text-meta font-normal text-label">{count}</span>}
      </h2>
      <p className="m-0 text-ui text-text-secondary">{copy.history.intro}</p>
      <div className="rounded-card bg-card px-3.5 py-1">
        <StandingRuleList surface="card" />
      </div>
    </section>
  );
}

/** Settings › Safety › Always allowed: the same rules, across hobs. */
export function StandingRuleSettings() {
  return (
    <section aria-label={copy.settings.heading} className="flex flex-col gap-3">
      <h3 className="lbl m-0 text-label">{copy.settings.heading}</h3>
      <p className="m-0 text-ui text-text-secondary">{copy.settings.intro}</p>
      <StandingRuleList surface="plain" />
    </section>
  );
}
