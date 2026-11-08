import type { HobProposalView } from "@hobbots/api";
import type { AgentId, CharmOperationId, HobProposal, HobProposalRow } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@hobbots/ui/components/collapsible";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import {
  type HobProposalDecision,
  hobProposalClosed,
  hobProposalQuery,
  useDecideHobProposal,
} from "../../api/hob-proposals.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import {
  allowableRows,
  alwaysOffers,
  changeLines,
  createdHobs,
  hobProposalWhat,
  operationWords,
  rowDraft,
  rowLook,
  summonFacts,
} from "./hob-proposal-model.ts";
import { messages } from "./messages.ts";

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

const STATE_TONE: Record<HobProposalRow["state"], string> = {
  pending: "text-lantern",
  allowed: "text-mint",
  denied: "text-label",
  failed: "text-rose",
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
}: {
  view: HobProposalView;
  /** The manager's name. */
  who: string;
  /** Shows what the proposal asks above it, as the chat does; the Inbox has it as its title. */
  heading?: boolean;
}) {
  const { proposal, changedSince } = view;
  const decide = useDecideHobProposal(proposal.id);
  const [confirmed, setConfirmed] = useState(false);
  const open = proposal.state === "open";
  const busy = decide.isPending;
  const send = (decision: HobProposalDecision) => decide.mutate(decision);
  const allowable = allowableRows(proposal, changedSince);
  const pending = proposal.rows.filter((row) => row.state === "pending");
  const what = hobProposalWhat(proposal, who);
  return (
    <section
      aria-label={copy.cardLabel({ what })}
      data-testid="hob-proposal"
      data-state={proposal.state}
      className="flex flex-col gap-3 rounded-card border border-line-2 bg-card p-3"
    >
      {heading && <h3 className="m-0 text-ui font-semibold text-text-strong">{what}</h3>}
      {proposal.safety !== null && open && (
        <p className="m-0 text-detail text-lantern">{copy.safety({ reason: proposal.safety })}</p>
      )}
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
      <AlwaysAllow proposal={proposal} who={who} busy={busy} onDecide={send} />
      <CreatedHobs proposal={proposal} />
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
    </section>
  );
}

function ProposalRow({
  proposal,
  row,
  changed,
  busy,
  confirmed,
  onConfirm,
  onDecide,
}: {
  proposal: HobProposal;
  row: HobProposalRow;
  changed: boolean;
  busy: boolean;
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
  onDecide: (decision: HobProposalDecision) => void;
}) {
  const waiting = row.state === "pending";
  const retire = proposal.kind === "retire";
  return (
    <article
      aria-label={row.label}
      data-state={row.state}
      className="flex flex-col gap-2 rounded-control border border-line bg-deep px-3 py-2.5"
    >
      <RowBody proposal={proposal} row={row} />
      <span className={cn("text-meta", STATE_TONE[row.state])}>
        {copy.state[row.state]}
        {row.outcome !== null && row.state !== "pending" && (
          <span className="text-text-secondary">{` · ${row.outcome}`}</span>
        )}
      </span>
      {waiting && changed && <p className="m-0 text-meta text-lantern">{copy.changedSince}</p>}
      {waiting && retire && !changed && (
        <div className="flex flex-col gap-2 rounded-control bg-rose/15 px-3 py-2.5">
          <span className="text-detail font-bold text-rose">{copy.retire.highRisk}</span>
          <label className="flex cursor-pointer items-center gap-2 text-ui">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirm(event.target.checked)}
              className="size-4 accent-mint"
            />
            {copy.retire.confirm({ hob: row.label })}
          </label>
        </div>
      )}
      {waiting && (
        <div className="flex flex-wrap gap-2">
          {!changed && (
            <Button
              size="sm"
              variant="approve"
              onClick={() => onDecide({ _tag: "allow", rowId: row.id, ...(proposal.highRisk ? { confirmed } : {}) })}
              disabled={busy || (retire && !confirmed)}
            >
              {copy.allow}
            </Button>
          )}
          {proposal.kind === "summon" && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/summon" search={{ proposal: proposal.id, row: row.id }}>
                {copy.edit}
              </Link>
            </Button>
          )}
          <Button size="sm" variant="deny" onClick={() => onDecide({ _tag: "deny", rowId: row.id })} disabled={busy}>
            {copy.deny}
          </Button>
        </div>
      )}
    </article>
  );
}

/** What one row proposes: a new hob in full, a change as before and after, or a pause, wake or retire. */
function RowBody({ proposal, row }: { proposal: HobProposal; row: HobProposalRow }) {
  switch (proposal.kind) {
    case "summon":
      return <SummonRow row={row} />;
    case "change":
      return <ChangeRow row={row} />;
    case "retire":
      return (
        <div className="flex flex-col gap-1">
          <b className="text-ui text-text-strong">{row.label}</b>
          <span className="text-detail text-text-secondary">{copy.retire.owns({ hob: row.label })}</span>
          <span className="text-detail text-text-secondary">
            {row.runningReplies === "stop" ? copy.retire.stop : copy.retire.finish}
          </span>
        </div>
      );
    default:
      return (
        <div className="flex flex-col gap-1">
          <b className="text-ui text-text-strong">{row.label}</b>
          <span className="text-detail text-text-secondary">
            {proposal.kind === "pause" ? copy.pause({ hob: row.label }) : copy.wake({ hob: row.label })}
          </span>
        </div>
      );
  }
}

/** A new hob: its sprite, name and role, its facts, and its instructions folded. */
function SummonRow({ row }: { row: HobProposalRow }) {
  const draft = rowDraft(row);
  const facts = summonFacts(draft);
  const [role, ...rest] = facts;
  const instructions = draft.instructions?.trim() ?? "";
  return (
    <div className="flex items-start gap-3">
      <HobSprite hob={rowLook(draft)} size={40} badge />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex flex-wrap items-baseline gap-2">
          <b className="font-heading text-ui text-text-strong">{draft.name ?? row.label}</b>
          {role !== undefined && <span className="text-detail text-text-secondary">{role[1]}</span>}
          {row.edited !== null && (
            <span className="rounded-tag bg-line px-1.5 text-meta text-text-strong">{copy.editedNote}</span>
          )}
        </span>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta text-text-secondary">
          {rest.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-label">{label}</dt>
              <dd className="m-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <Folded label={copy.instructions} text={instructions === "" ? copy.noInstructions : instructions} />
      </div>
    </div>
  );
}

/** A change to one hob: each field it gives, as the hob has it now and as it would be. */
function ChangeRow({ row }: { row: HobProposalRow }) {
  return (
    <div className="flex flex-col gap-1.5">
      <b className="text-ui text-text-strong">{row.label}</b>
      <table className="w-full border-collapse text-meta">
        <thead className="sr-only">
          <tr>
            <th scope="col">{copy.fields.name}</th>
            <th scope="col">{copy.before}</th>
            <th scope="col">{copy.after}</th>
          </tr>
        </thead>
        <tbody>
          {changeLines(row).map((line) => (
            <tr key={line.key} className="align-top">
              <th scope="row" className="py-0.5 pe-3 text-start font-normal text-label">
                {line.label}
              </th>
              {line.long ? (
                <td colSpan={2} className="py-0.5">
                  <Folded label={copy.before} text={line.before} />
                  <Folded label={copy.after} text={line.after} />
                </td>
              ) : (
                <>
                  <td className="py-0.5 pe-3 text-text-secondary line-through decoration-rose/60">{line.before}</td>
                  <td className="py-0.5 text-text-strong">{line.after}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Folded({ label, text }: { label: string; text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 border-0 bg-transparent p-0 text-meta text-label hover:text-text-strong focus-visible:outline-2 focus-visible:outline-focus-ring">
        <span aria-hidden className="group-data-[state=open]:rotate-90">
          ›
        </span>
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="m-0 mt-1 whitespace-pre-wrap break-words rounded-control bg-panel px-2 py-1.5 font-mono text-meta text-text-secondary">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** "Always allow" for each field that asked, and once set, that it was set, as a change made by you. */
function AlwaysAllow({
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
  if (offers.length === 0 && set.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {offers.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {offers.map((operation: CharmOperationId) => (
              <Button
                key={operation}
                size="sm"
                variant="outline"
                onClick={() => onDecide({ _tag: "alwaysAllow", operation })}
                disabled={busy}
              >
                {copy.alwaysAllow({ words: operationWords(operation) })}
              </Button>
            ))}
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
function CreatedHobs({ proposal }: { proposal: HobProposal }) {
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
      aria-label={copy.createdOpen({ name })}
      data-testid="created-hob"
      className="hop-on-hover flex items-center gap-2.5 rounded-card border border-line-2 bg-deep px-3 py-2 text-text-strong no-underline hover:border-mint focus-visible:outline-2 focus-visible:outline-focus-ring"
    >
      <HobSprite hob={rowLook(draft)} size={28} badge />
      <span className="flex flex-col">
        <b className="font-heading text-ui">{name}</b>
        <span className="text-meta text-text-secondary">{summonFacts(draft)[0]?.[1]}</span>
      </span>
    </Link>
  );
}

/** The card on a Summoning call's step in the chat, read by its proposal's id. */
export function HobProposalStep({ proposalId, who }: { proposalId: string; who: string }) {
  const view = useQuery(hobProposalQuery(proposalId));
  if (view.isPending) return <p className="m-0 ps-5.5 text-meta text-label">{copy.loading}</p>;
  if (view.isError) return <p className="m-0 ps-5.5 text-meta text-rose">{copy.loadFailed}</p>;
  return (
    <div className="ps-5.5 pt-1">
      <HobProposalCard view={view.data} who={who} heading />
    </div>
  );
}
