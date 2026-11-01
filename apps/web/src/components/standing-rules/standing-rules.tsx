import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { grantsQuery } from "../../api/grants.ts";
import { agentsQuery } from "../../api/queries.ts";
import { messages } from "./messages.ts";
import { StandingRuleRow } from "./standing-rule-row.tsx";
import { standingRules } from "./standing-rules.ts";

const copy = messages;

/**
 * Every "Always" rule that applies now, of every hob (ADR 015): what it allows, for which hob, when
 * it was saved and last used, and the request that saved it. Each can be removed, after asking.
 * Inbox History and Settings › Permissions show the same list.
 */
function StandingRuleList() {
  const grants = useQuery(grantsQuery);
  const hobs = useQuery(agentsQuery);
  if (grants.isPending) return <p className="m-0 text-sm text-label">{copy.loading}</p>;
  if (grants.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm text-rose">
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
        <span className="text-sm text-secondary-text">{copy.emptyHint}</span>
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

/** The standing rules at the top of Inbox History, above the decisions. */
export function StandingRules() {
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-3">
      <span className="lbl text-xs text-label">{copy.heading}</span>
      <h2 className="m-0 font-pixel text-2xl font-bold text-moonlight">{copy.history.title}</h2>
      <p className="m-0 text-sm text-secondary-text">{copy.history.intro}</p>
      <div className="cut bg-panel px-4 py-2">
        <StandingRuleList />
      </div>
    </section>
  );
}

/** Settings › Permissions › Standing rules: the same rules, across hobs. */
export function StandingRuleSettings() {
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2 pt-2">
      <span className="lbl text-label">{copy.heading}</span>
      <p className="m-0 text-sm text-secondary-text">{copy.settings.intro}</p>
      <StandingRuleList />
    </section>
  );
}
