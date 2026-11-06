import type { SkillProposalView } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import { proposalClosed, useDecideProposal } from "../../api/skill-proposals.ts";
import { DraftForm } from "../draft-form/draft-form.tsx";
import { messages } from "./messages.ts";
import {
  addLabel,
  proposalDestination,
  proposalLines,
  proposalOutcome,
  proposalRevision,
  skillTitle,
} from "./proposal-model.ts";

const copy = messages;

const SIGN = { add: "+", del: "−", same: " " } as const;

/**
 * What a proposal adds or changes: the revision line, the skill's `SKILL.md` and where it goes, then
 * each line, added, removed or the same, against the revision it changes, or the newest one when the
 * skill moved on since the hob read it.
 */
export function ProposalDiff({ view, who }: { view: SkillProposalView; who: string }) {
  return (
    <section
      aria-label={copy.diffLabel}
      className="overflow-hidden rounded-card border border-line-2 bg-card"
      data-testid="proposal-diff"
    >
      <div className="flex items-center gap-2 border-b border-line bg-deep px-3 py-2.5 text-detail">
        <span className="flex-none rounded-control bg-line px-1.5 font-mono text-meta text-text-strong">
          {proposalRevision(view)}
        </span>
        <span className="min-w-0 flex-1 truncate text-text-strong">
          {copy.file({ title: skillTitle(view.proposal.name) })}
        </span>
        <span className="text-label">{proposalDestination(view, who)}</span>
      </div>
      <ul className="m-0 list-none p-0 py-1 font-mono">
        {proposalLines(view).map((line, at) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines have no identity but their place (STD-REACT-020).
            key={at}
            className={cn(
              "flex gap-2.5 px-3 py-1 text-detail",
              line.op === "add" && "bg-[color-mix(in_srgb,var(--color-mint)_12%,transparent)] text-text-strong",
              line.op === "del" && "bg-[color-mix(in_srgb,var(--color-rose)_12%,transparent)] text-text-strong",
              line.op === "same" && "text-text-secondary",
            )}
          >
            <span
              aria-hidden
              className={cn("w-2.5 flex-none", line.op === "add" && "text-mint", line.op === "del" && "text-rose")}
            >
              {SIGN[line.op]}
            </span>
            {line.op !== "same" && (
              <span className="sr-only">{`${line.op === "add" ? copy.added : copy.removed}: `}</span>
            )}
            <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a failed decision says. */
const errorText = (error: unknown) => {
  if (proposalClosed(error)) return copy.closed;
  if (error instanceof ApiError && error.tag === "SkillImportRefused") return copy.refused({ message: error.message });
  return copy.failed;
};

/**
 * Your decision on a proposal while it waits: Add it (for the hob, or rolled out), Edit then add, or
 * Not now. Once decided, what happened.
 */
export function ProposalDecision({ view, who }: { view: SkillProposalView; who: string }) {
  const { proposal } = view;
  const decide = useDecideProposal(proposal);
  const [editing, setEditing] = useState(false);
  const waiting = proposal.state === "waiting";
  const busy = decide.isPending;
  return (
    <div className="flex flex-col gap-3">
      {waiting && editing && (
        <DraftForm
          initial={proposal.instructions}
          label={copy.editLabel}
          hint={copy.editHint}
          submit={copy.addEdited}
          back={copy.cancelEdit}
          rows={12}
          code
          busy={busy}
          onSubmit={(instructions) => decide.mutate({ _tag: "add", instructions })}
          onBack={() => setEditing(false)}
        />
      )}
      {waiting && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => decide.mutate({ _tag: "add" })} disabled={busy}>
            {addLabel(view, who)}
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
            {copy.editThenAdd}
          </Button>
          <Button variant="quiet" onClick={() => decide.mutate({ _tag: "decline" })} disabled={busy}>
            {copy.notNow}
          </Button>
        </div>
      )}
      {!waiting && (
        <p role="status" className="m-0 text-ui text-text-strong">
          {proposalOutcome(proposal, who)}
        </p>
      )}
      {decide.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {errorText(decide.error)}
        </p>
      )}
    </div>
  );
}
