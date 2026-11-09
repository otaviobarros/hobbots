import type { AgentId, CharmOperationId, HobProposal, HobProposalRow } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";
import type { HobProposalDecision } from "../../api/hob-proposals.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { alwaysOffers, createdHobs, operationWords, rowDraft, rowLook, summonFacts } from "./hob-proposal-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** "Always allow" for each field that asked, and once set, that it was set, as a change made by you. */
export function AlwaysAllow({
  proposal,
  who,
  busy,
  onDecide,
}: {
  proposal: HobProposal;
  who: string;
  busy: boolean;
  onDecide: (decision: HobProposalDecision) => void;
}) {
  const offers = alwaysOffers(proposal);
  const set = proposal.alwaysAllowed;
  if (!Arr.isReadonlyArrayNonEmpty(offers) && set.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {Arr.isReadonlyArrayNonEmpty(offers) && (
        <>
          <div className="flex flex-wrap gap-2">
            {offers.map((operation: CharmOperationId) => (
              <Button
                key={operation}
                size="sm"
                variant="outline"
                onClick={() => onDecide({ _tag: "alwaysAllow", operations: [operation] })}
                disabled={busy}
              >
                {copy.alwaysAllow({ words: operationWords(operation) })}
              </Button>
            ))}
            {/* Every field that asked, in one change, when more than one did. */}
            {offers.length > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDecide({ _tag: "alwaysAllow", operations: offers })}
                disabled={busy}
              >
                {copy.alwaysAllowAll}
              </Button>
            )}
          </div>
          <span className="text-meta text-label">{copy.alwaysHint({ who })}</span>
        </>
      )}
      {set.length > 0 && (
        <p role="status" className="m-0 text-detail text-mint">
          {copy.alwaysSet({ who, words: set.map(operationWords) })}{" "}
          <Link to="/hobs/$hobId" params={{ hobId: proposal.agentId }} search={{ tab: "history" }}>
            {copy.history}
          </Link>
        </p>
      )}
    </div>
  );
}

/** A card per hob the proposal made, which opens its profile. */
export function CreatedHobs({ proposal }: { proposal: HobProposal }) {
  const made = createdHobs(proposal);
  if (made.length === 0) return null;
  return (
    <section aria-label={copy.created} className="flex flex-col gap-1.5">
      <h4 className="lbl m-0 text-label">{copy.created}</h4>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {made.map((hob) => (
          <li key={hob.hobId}>
            <CreatedHob hobId={hob.hobId} name={hob.name} row={hob.row} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CreatedHob({ hobId, name, row }: { hobId: AgentId; name: string; row: HobProposalRow }) {
  const draft = rowDraft(row);
  return (
    <Link
      to="/hobs/$hobId/profile"
      params={{ hobId }}
      data-testid="created-hob"
      className="hop-on-hover flex items-center gap-2.5 rounded-card border border-line-2 bg-deep px-3 py-2 text-text-strong no-underline hover:border-mint focus-visible:outline-2 focus-visible:outline-focus-ring"
    >
      <HobSprite hob={rowLook(draft)} size={28} badge />
      <span className="flex flex-col">
        {/* Read out as "Open Flo Writer": the visible name and role stay in its name (label-content-name). */}
        <b className="font-heading text-ui">
          <span className="sr-only">{copy.createdOpen} </span>
          {name}
        </b>
        <span className="text-meta text-text-secondary">{summonFacts(draft)[0]?.[1]}</span>
      </span>
    </Link>
  );
}
