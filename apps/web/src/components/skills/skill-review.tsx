import type { SkillProposalView } from "@hobbots/api";
import { skillProposalOpen } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { skillProposalsQuery } from "../../api/skill-proposals.ts";
import { formatWhen } from "../../lib/time.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { messages as reviewCopy } from "../skill-review/messages.ts";
import { ProposalDecision, ProposalDiff } from "../skill-review/proposal-card.tsx";
import { proposalFoot, proposalWhat } from "../skill-review/proposal-model.ts";
import { messages } from "./messages.ts";
import { type HobDirectory, skillsSearchOf } from "./skills-model.ts";
import { PaneNotRead } from "./skills-views.tsx";
import { TrialDraft } from "./trial-draft.tsx";

const copy = messages.review;

const row =
  "flex flex-col gap-0.5 bg-card px-3.5 py-2.5 text-start text-inherit no-underline hover:bg-hover aria-[current=page]:bg-hover";

const whoOf = (view: SkillProposalView, hobs: HobDirectory) =>
  hobs.get(view.proposal.agentId)?.name ?? messages.scopes.formerHob;

/** The proposals To review lists: those that wait, and the one open while you decide it. */
const shownOf = (views: ReadonlyArray<SkillProposalView>, item: string | null) =>
  views.filter((view) => skillProposalOpen(view.proposal) || view.proposal.id === item);

/** Where a proposal came from: a chat whenever it was asked for in one, even one that read memory pages. */
const fromLine = (view: SkillProposalView, who: string) =>
  view.proposal.threadId === null && view.proposal.memoryPages.length > 0
    ? copy.fromMemory({ who })
    : copy.from({ who });

function ReviewRow({ view, hobs, open }: { view: SkillProposalView; hobs: HobDirectory; open: boolean }) {
  const who = whoOf(view, hobs);
  const { proposal } = view;
  return (
    <li>
      <Link
        to="/skills"
        search={skillsSearchOf({ _tag: "Review", item: proposal.id })}
        aria-current={open ? "page" : undefined}
        className={row}
      >
        <span className="text-meta text-label">{fromLine(view, who)}</span>
        <span className="text-meta font-semibold text-text-secondary">
          {proposal.base === null ? copy.newSkill : copy.change}
        </span>
        <span className="text-ui text-text-strong">{proposalWhat(proposal, who)}</span>
      </Link>
    </li>
  );
}

/** One proposal as it is decided: why, what it adds or changes, who suggested it, then the decision. */
function ReviewDetail({
  view,
  hobs,
  now,
  tried,
}: {
  view: SkillProposalView;
  hobs: HobDirectory;
  now: Date;
  /** Your edit of this proposal as you tried it in a chat, which Edit then add opens on. */
  tried: string | null;
}) {
  const { proposal } = view;
  const who = whoOf(view, hobs);
  const stale =
    view.latest !== null && proposal.base !== null
      ? reviewCopy.stale({ who, base: proposal.base.number, latest: view.latest.number })
      : null;
  const learned =
    proposal.memoryPages.length > 0
      ? proposal.memoryPages.join(", ")
      : proposal.threadId !== null
        ? reviewCopy.learnedChat
        : null;
  return (
    <article aria-label={proposalWhat(proposal, who)} className="flex min-w-0 flex-1 flex-col gap-3.5">
      <header className="flex flex-col gap-1">
        <span className="lbl text-label">{proposal.base === null ? copy.newSkill : copy.change}</span>
        <h3 className="m-0 text-title text-text-strong">{proposalWhat(proposal, who)}</h3>
        {proposal.why !== "" && <p className="m-0 text-detail text-text-secondary">{proposal.why}</p>}
      </header>
      {stale !== null && <p className="m-0 text-detail text-lantern">{stale}</p>}
      <ProposalDiff view={view} who={who} />
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-detail">
        <dt className="text-label">{reviewCopy.facts.suggestedBy}</dt>
        <dd className="m-0 text-text-strong">{`${who} · ${formatWhen(proposal.createdAt, now)}`}</dd>
        {learned !== null && (
          <>
            <dt className="text-label">{reviewCopy.learnedFrom}</dt>
            <dd className="m-0 text-text-strong">{learned}</dd>
          </>
        )}
      </dl>
      {proposal.threadId !== null && (
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId: proposal.agentId, threadId: proposal.threadId }}
          className="self-start text-ui text-link"
        >
          {copy.openChat}
        </Link>
      )}
      <ProposalDecision key={proposal.id} view={view} who={who} tried={tried} />
      {skillProposalOpen(proposal) && <p className="m-0 text-meta text-label">{proposalFoot(view)}</p>}
    </article>
  );
}

/**
 * Skills › To review (ADR 029, Proactive hobs): the skills hobs drafted and the changes they suggest,
 * which wait for you whatever the safety level, with the one open beside the list. They show in the
 * Inbox too, and a decision in either place closes both.
 */
export function SkillReview({
  item,
  hobs,
  now,
  trial = null,
}: {
  item: string | null;
  hobs: HobDirectory;
  now: Date;
  /** The chat whose tried proposal opens on the text you tried there (ADR 029, Try in a chat). */
  trial?: string | null;
}) {
  return (
    <TrialDraft key={trial ?? "none"} trial={trial}>
      {(draft) => (
        <ReviewList
          item={item}
          hobs={hobs}
          now={now}
          tried={draft !== null && draft.trial.proposalId === item ? draft.text : null}
        />
      )}
    </TrialDraft>
  );
}

function ReviewList({
  item,
  hobs,
  now,
  tried,
}: {
  item: string | null;
  hobs: HobDirectory;
  now: Date;
  tried: string | null;
}) {
  const proposals = useQuery(skillProposalsQuery);
  // With none picked, the first that waits opens, and stays open once you decide it.
  const [first, setFirst] = useState<string | null>(null);
  if (proposals.data === undefined)
    return (
      <PaneNotRead
        failed={proposals.isError}
        text={copy.failed}
        retry={copy.retry}
        onRetry={() => void proposals.refetch()}
      />
    );
  const picked = item ?? first;
  const shown = shownOf(proposals.data, picked);
  const open = shown.find((view) => view.proposal.id === picked) ?? shown[0];
  if (item === null && open !== undefined && first !== open.proposal.id) setFirst(open.proposal.id);
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[760px] text-ui text-text-secondary">{copy.intro}</p>
      {open === undefined ? (
        <p className="m-0 text-ui text-text-secondary">{copy.empty}</p>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <div className="w-[300px] max-w-full flex-none">
            <RowList label={copy.listLabel}>
              {shown.map((view) => (
                <ReviewRow key={view.proposal.id} view={view} hobs={hobs} open={view === open} />
              ))}
            </RowList>
          </div>
          <ReviewDetail
            key={open.proposal.id}
            view={open}
            hobs={hobs}
            now={now}
            tried={open.proposal.id === item ? tried : null}
          />
        </div>
      )}
    </div>
  );
}
