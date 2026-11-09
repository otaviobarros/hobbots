import type { HobProposalView } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type Ref, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import {
  type HobProposalDecision,
  hobProposalClosed,
  hobProposalQuery,
  useDecideHobProposal,
} from "../../api/hob-proposals.ts";
import type { FocusTargets } from "../move-on/follow-focus.ts";
import { useMoveOn } from "../move-on/move-on.tsx";
import { allowableRows, hobProposalWhat } from "./hob-proposal-model.ts";
import { messages } from "./messages.ts";
import { AlwaysAllow, CreatedHobs } from "./proposal-extras.tsx";
import { ProposalRow } from "./proposal-row.tsx";

const copy = messages;

/** What a failed decision says. */
const errorText = (error: unknown) => {
  if (hobProposalClosed(error)) return copy.closed;
  if (!(error instanceof ApiError)) return copy.failed;
  switch (error.tag) {
    case "HobProposalChangedSince":
      return copy.changed;
    case "HobProposalNotConfirmed":
      return copy.notConfirmed;
    case "HobProposalRefused":
      return copy.refused({ message: String(error.fields.message ?? error.message) });
    default:
      return copy.failed;
  }
};

/**
 * A hob proposal as one card (ADR 034, Asking is a proposal), the same in the Inbox and on the call's
 * step in the chat: a row per hob, each with Allow and Deny, and Edit in Summon for a new hob; Allow
 * all and Deny all; "Always allow" for each field that asked; and once a summon row is allowed, a
 * card for the hob it made, which opens its profile.
 */
export function HobProposalCard({
  view,
  who,
  heading = false,
  bare = false,
  targets,
}: {
  view: HobProposalView;
  /** The manager's name. */
  who: string;
  /** Shows what the proposal asks above it, as the chat does; the Inbox has it as its title. */
  heading?: boolean;
  /** In the Needs-you tray: no edge or label of its own, since the tray gives both. */
  bare?: boolean;
  /**
   * Where focus goes when a decision takes away the control that had it, as the tray's other items
   * do (#995): its next item, else the composer. Without it, as in the Inbox, the page's own.
   */
  targets?: FocusTargets;
}) {
  const { proposal, changedSince } = view;
  const decide = useDecideHobProposal(proposal.id);
  const [confirmed, setConfirmed] = useState(false);
  const open = proposal.state === "open";
  const busy = decide.isPending;
  const frame = useRef<HTMLDivElement>(null);
  const moveOn = useMoveOn();
  const send = (decision: HobProposalDecision) => {
    if (targets === undefined) decide.mutate(decision);
    else moveOn({ from: frame.current, targets, sent: decide.mutateAsync(decision) });
  };
  const allowable = allowableRows(proposal, changedSince);
  const pending = proposal.rows.filter((row) => row.state === "pending");
  const what = hobProposalWhat(proposal, who);
  return (
    <ProposalFrame frameRef={frame} label={copy.cardLabel({ what })} state={proposal.state} bare={bare}>
      {heading && <h3 className="m-0 text-ui font-semibold text-text-strong">{what}</h3>}
      {proposal.safety !== null && open && (
        <p className="m-0 text-detail text-lantern">{copy.safety({ reason: proposal.safety })}</p>
      )}
      <Grows bare={bare}>
        <ul aria-label={copy.rows} className="m-0 flex list-none flex-col gap-2 p-0">
          {proposal.rows.map((row) => (
            <li key={row.id}>
              <ProposalRow
                proposal={proposal}
                row={row}
                changed={changedSince.includes(row.id)}
                busy={busy}
                confirmed={confirmed}
                onConfirm={setConfirmed}
                onDecide={send}
              />
            </li>
          ))}
        </ul>
        {/* In the tray, Always allow and the hobs made sit with the rows, so they scroll with them. */}
        {bare && <AlwaysAllow proposal={proposal} who={who} busy={busy} onDecide={send} />}
        {bare && <CreatedHobs proposal={proposal} />}
      </Grows>
      {open && pending.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="approve"
            onClick={() => send({ _tag: "allowAll", ...(proposal.highRisk ? { confirmed } : {}) })}
            disabled={busy || allowable.length === 0}
          >
            {copy.allowAll}
          </Button>
          <Button variant="deny" onClick={() => send({ _tag: "denyAll" })} disabled={busy}>
            {copy.denyAll}
          </Button>
        </div>
      )}
      {!bare && <AlwaysAllow proposal={proposal} who={who} busy={busy} onDecide={send} />}
      {!bare && <CreatedHobs proposal={proposal} />}
      {!open && (
        <p role="status" className="m-0 text-detail text-text-secondary">
          {copy.settled({ who })}
        </p>
      )}
      {decide.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {errorText(decide.error)}
        </p>
      )}
    </ProposalFrame>
  );
}

/**
 * What grows with the proposal: its rows, Always allow and the hobs it made. In the tray they scroll
 * together in one bounded box, so however many rows or created hobs there are, the composer and Allow
 * all and Deny all stay in the window (STD-TEST-010).
 */
function Grows({ bare, children }: { bare: boolean; children: ReactNode }) {
  if (!bare) return children;
  return <div className="flex max-h-[40vh] min-h-24 flex-col gap-3 overflow-y-auto">{children}</div>;
}

/** The card's own edge and name, or, in the tray, only its column. */
function ProposalFrame({
  frameRef,
  label,
  state,
  bare,
  children,
}: {
  frameRef: Ref<HTMLDivElement>;
  label: string;
  state: string;
  bare: boolean;
  children: ReactNode;
}) {
  if (bare) {
    return (
      <div ref={frameRef} data-testid="hob-proposal" data-state={state} className="flex min-h-0 flex-col gap-3">
        {children}
      </div>
    );
  }
  return (
    <section
      ref={frameRef}
      aria-label={label}
      data-testid="hob-proposal"
      data-state={state}
      className="flex flex-col gap-3 rounded-card border border-line-2 bg-card p-3"
    >
      {children}
    </section>
  );
}

/**
 * On a Summoning call's step in the chat: while the proposal waits, one line pointing to the Needs-you
 * tray above the composer, where you decide it (one place asks for you); once decided, the card with
 * what came of each row and the hobs it made.
 */
export function HobProposalStep({ proposalId, who }: { proposalId: string; who: string }) {
  const view = useQuery(hobProposalQuery(proposalId));
  if (view.isPending) return <p className="m-0 ps-5.5 text-meta text-label">{copy.loading}</p>;
  if (view.isError) return <p className="m-0 ps-5.5 text-meta text-rose">{copy.loadFailed}</p>;
  if (view.data.proposal.state === "open") {
    return <p className="m-0 ps-5.5 text-meta text-lantern">{copy.inTray}</p>;
  }
  return (
    <div className="ps-5.5 pt-1">
      <HobProposalCard view={view.data} who={who} heading />
    </div>
  );
}
