import type { HobProposal, HobProposalRow } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { HobProposalDecision } from "../../api/hob-proposals.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { changeLines, rowDraft, rowLook, summonFacts } from "./hob-proposal-model.ts";
import { messages } from "./messages.ts";
import { type RetireReview, RetireRow, useRetireReview } from "./retire-row.tsx";

const copy = messages;

const STATE_TONE: Record<HobProposalRow["state"], string> = {
  pending: "text-lantern",
  applying: "text-label",
  allowed: "text-mint",
  denied: "text-label",
  failed: "text-rose",
};

/** One hob of a proposal: what it proposes, where it stands, and its own decision while it waits. */
export function ProposalRow({
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
  const review = useRetireReview(row, retire && waiting);
  // A retire is allowed only once what the hob has running and open was read.
  const unreviewed = retire && review.state !== "read";
  return (
    <article
      aria-label={row.label}
      data-state={row.state}
      className="flex flex-col gap-2 rounded-control border border-line bg-deep px-3 py-2.5"
    >
      <RowBody proposal={proposal} row={row} review={review} />
      <RowState row={row} />
      {waiting && changed && <p className="m-0 text-meta text-lantern">{copy.changedSince}</p>}
      {waiting && retire && !changed && (
        <RetireConfirm hob={row.label} confirmed={confirmed} disabled={unreviewed} onConfirm={onConfirm} />
      )}
      {waiting && (
        <div className="flex flex-wrap gap-2">
          {!changed && (
            <Button
              size="sm"
              variant="approve"
              onClick={() => onDecide({ _tag: "allow", rowId: row.id, ...(proposal.highRisk ? { confirmed } : {}) })}
              disabled={busy || unreviewed || (retire && !confirmed)}
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

/** Where the row stands, with what came of it once decided. */
export function RowState({ row }: { row: HobProposalRow }) {
  return (
    <span className={cn("text-meta", STATE_TONE[row.state])}>
      {copy.state[row.state]}
      {row.outcome !== null && row.state !== "pending" && (
        <span className="text-text-secondary">{` · ${row.outcome}`}</span>
      )}
    </span>
  );
}

/** Retiring is high risk: the check box that allowing it needs, on once what the hob has open was read. */
function RetireConfirm({
  hob,
  confirmed,
  disabled,
  onConfirm,
}: {
  hob: string;
  confirmed: boolean;
  disabled: boolean;
  onConfirm: (confirmed: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-control bg-rose/15 px-3 py-2.5">
      <span className="text-detail font-bold text-rose">{copy.retire.highRisk}</span>
      <label className="flex cursor-pointer items-center gap-2 text-ui">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(event) => onConfirm(event.target.checked)}
          className="size-4 accent-mint"
        />
        {copy.retire.confirm({ hob })}
      </label>
    </div>
  );
}

/** What one row proposes: a new hob in full, a change as before and after, or a pause, wake or retire. */
function RowBody({ proposal, row, review }: { proposal: HobProposal; row: HobProposalRow; review: RetireReview }) {
  switch (proposal.kind) {
    case "summon":
      return <SummonRow row={row} />;
    case "change":
      return <ChangeRow row={row} />;
    case "retire":
      return <RetireRow row={row} review={review} />;
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
              <dt className="whitespace-nowrap text-label wrap-normal">{label}</dt>
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
              <th scope="row" className="py-0.5 pe-3 text-start font-normal whitespace-nowrap text-label wrap-normal">
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

/** Long text, such as instructions, folded under its label. */
function Folded({ label, text }: { label: string; text: string }) {
  return (
    <details className="group text-meta">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label hover:text-text-strong focus-visible:outline-2 focus-visible:outline-focus-ring">
        <span aria-hidden className="group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <p className="m-0 mt-1 whitespace-pre-wrap break-words rounded-control bg-panel px-2 py-1.5 font-mono text-text-secondary">
        {text}
      </p>
    </details>
  );
}
