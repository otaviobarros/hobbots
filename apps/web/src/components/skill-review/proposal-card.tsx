import type { SkillProposalCheck, SkillProposalView } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import { proposalClosed, useCheckProposal, useDecideProposal } from "../../api/skill-proposals.ts";
import { DraftForm } from "../draft-form/draft-form.tsx";
import { messages } from "./messages.ts";
import {
  addLabel,
  flagLines,
  lineParts,
  proposalDestination,
  proposalLines,
  proposalOutcome,
  proposalReuse,
  proposalRevision,
  skillTitle,
} from "./proposal-model.ts";
import { TryProposal, useProposalEdit } from "./try-proposal.tsx";

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
            <span className="min-w-0 whitespace-pre-wrap break-words">
              <LineText text={line.text} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A line of the skill, with each character you cannot see marked in its place by its code point. */
function LineText({ text }: { text: string }) {
  return lineParts(text).map((part, at) =>
    part._tag === "text" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a line's pieces have no identity but their place (STD-REACT-020).
      <span key={at}>{part.text}</span>
    ) : (
      <mark
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's pieces have no identity but their place (STD-REACT-020).
        key={at}
        title={copy.hiddenMark(part)}
        className="rounded-control bg-[color-mix(in_srgb,var(--color-lantern)_24%,transparent)] px-0.5 text-meta text-text-strong"
      >
        {part.codePoint}
      </mark>
    ),
  );
}

/**
 * What the checks find in it before it is added: each script, URL and hidden character, and when its
 * content is already a revision of the skill, that adding it changes nothing or brings that one back.
 */
function ProposalFlags({ view, check }: { view: SkillProposalView; check: SkillProposalCheck | null }) {
  const lines = flagLines(check?.flags ?? []);
  const reuse = proposalReuse(view, check);
  if (lines.length === 0 && reuse === null) return null;
  return (
    <section
      aria-label={copy.flagsLabel}
      className="flex flex-col gap-1.5 rounded-card border border-line-2 bg-deep px-3 py-2.5"
    >
      <h3 className="m-0 text-detail text-text-strong">{copy.flagsLabel}</h3>
      <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-detail text-text-secondary">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {reuse !== null && <li>{reuse.as === "same" ? copy.footSame(reuse) : copy.footEarlier(reuse)}</li>}
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
export function ProposalDecision({
  view,
  who,
  tried = null,
}: {
  view: SkillProposalView;
  who: string;
  /** Your edit as you tried it in a chat: Edit then add opens on it (ADR 029, Try in a chat). */
  tried?: string | null;
}) {
  const { proposal } = view;
  const decide = useDecideProposal(proposal);
  const checking = useCheckProposal(proposal);
  const { editing, setEditing, edited, setEdited, opening, setOpening } = useProposalEdit(proposal, tried);
  // Your edit as the checks last found it: it is added only once you have seen what they found.
  const [checked, setChecked] = useState<{ readonly draft: string; readonly check: SkillProposalCheck } | null>(null);
  const waiting = proposal.state === "waiting";
  const busy = decide.isPending || checking.isPending;
  const addEdit = (draft: string) => {
    if (draft === proposal.instructions || checked?.draft === draft) {
      decide.mutate({ _tag: "add", instructions: draft });
      return;
    }
    checking.mutate(draft, {
      onSuccess: (check) => {
        if (check.flags.length === 0 && proposalReuse(view, check) === null) {
          decide.mutate({ _tag: "add", instructions: draft });
        } else {
          setChecked({ draft, check });
        }
      },
    });
  };
  const failure = checking.isError ? checking.error : decide.isError ? decide.error : null;
  return (
    <div className="flex flex-col gap-3">
      {waiting && <ProposalFlags view={view} check={editing && checked !== null ? checked.check : view.check} />}
      {waiting && editing && (
        <>
          <DraftForm
            initial={opening}
            label={copy.editLabel}
            hint={copy.editHint}
            submit={checked === null ? copy.addEdited : copy.addAnyway}
            back={copy.cancelEdit}
            rows={12}
            code
            busy={busy}
            onSubmit={addEdit}
            onChange={(draft) => {
              setEdited(draft);
              setChecked(null);
              checking.reset();
            }}
            onBack={() => {
              setEditing(false);
              setOpening(proposal.instructions);
              setEdited(proposal.instructions);
              setChecked(null);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <TryProposal proposal={proposal} instructions={edited} disabled={busy} />
          </div>
        </>
      )}
      {waiting && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => decide.mutate({ _tag: "add" })} disabled={busy}>
            {addLabel(view, who)}
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
            {copy.editThenAdd}
          </Button>
          <TryProposal proposal={proposal} instructions={null} disabled={busy} />
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
      {failure !== null && (
        <p role="alert" className="m-0 text-meta text-rose">
          {errorText(failure)}
        </p>
      )}
    </div>
  );
}
