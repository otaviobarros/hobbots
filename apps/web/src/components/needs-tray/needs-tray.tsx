import { type ApprovalSurface, exactAction } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useDecideApproval } from "../../api/approvals.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import { formatWhen } from "../../lib/time.ts";
import { ApprovalActions } from "../approvals/approval-actions.tsx";
import { decisionErrorText, expiryText } from "../approvals/approval-text.ts";
import { BlockerChoices, blockerChoice } from "../blockers/blocker-choices.tsx";
import { blockerWhat, blockerWhy } from "../blockers/blocker-model.ts";
import { messages as blockerCopy } from "../blockers/messages.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages as appCopy } from "../messages.ts";
import { messages as questMessages } from "../quest/messages.ts";
import { AnswerForm } from "../quest/question-card.tsx";
import { type HobLookup, useHobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { shownEntry, type TrayEntry } from "./tray-entries.ts";

const copy = messages;
const approvalCopy = appCopy.approval;
const questionCopy = questMessages.question;

type Hob = ReturnType<HobLookup>;

/**
 * Everything waiting on you, one item at a time, right above the composer: approvals, then stuck
 * work, then questions. "1 of 2" and Next step through them; deciding one shows the next. The
 * high-risk variant has a rose edge and its confirm box. Gone when nothing waits. The chat and Home
 * pass the entries they hold, and `via` names the surface a decision made here records.
 */
export function NeedsTray({
  entries,
  via = "chat",
  className,
}: {
  entries: ReadonlyArray<TrayEntry>;
  via?: ApprovalSurface;
  className?: string;
}) {
  const hobs = useHobLookup();
  const [place, setPlace] = useState<{ key: string | undefined; index: number }>({ key: undefined, index: 0 });
  const shown = shownEntry(entries, place.key, place.index);
  if (shown === undefined) return null;
  const { entry, index } = shown;
  const count = entries.length;
  const risky = entry.kind === "approval" && entry.request.onceOnly;
  const stuck = entry.kind === "stuck";
  const next = () => {
    const after = entries[(index + 1) % count];
    setPlace({ key: after?.key, index: (index + 1) % count });
  };
  const asker = hobs(askerOf(entry));
  return (
    <section
      aria-label={copy.label({ index: index + 1, count })}
      className={cn(
        "cut flex animate-hb-in gap-3 border-2 bg-card p-4",
        risky || stuck ? "border-rose" : "border-lantern",
        className,
      )}
    >
      {/* A new item hops its hob in the looks that hop, and fades in in the others. */}
      <span
        key={entry.key}
        className="flex size-9 shrink-0 animate-hb-in items-center justify-center self-start rounded-tile bg-tile [&_.sprite]:[animation:var(--hop)]"
      >
        <HobSprite hob={asker} size={28} />
      </span>
      <section
        key={`${entry.key}-body`}
        aria-label={itemLabel(entry, asker)}
        data-state="pending"
        className="flex min-w-0 flex-1 animate-hb-in flex-col gap-2"
      >
        <span
          className={cn(
            "flex items-center gap-1.5 text-meta font-bold tracking-[0.08em] uppercase",
            risky || stuck ? "text-rose" : "text-lantern",
          )}
        >
          <span aria-hidden className="size-1.5 rounded-dot bg-current" />
          {stuck ? copy.eyebrow.stuck : risky ? copy.eyebrow.risk : copy.eyebrow.needs}
        </span>
        <div className="flex items-center gap-2">
          <h2 className="m-0 min-w-0 flex-1 font-heading text-base leading-[22px] font-bold text-text-strong">
            {titleOf(entry, asker)}
          </h2>
          {count > 1 && (
            <span className="rounded-tag bg-line px-2 text-meta text-label">
              {copy.position({ index: index + 1, count })}
            </span>
          )}
          <Link to="/inbox" search={{ tab: "needs" }} className="text-detail text-text-strong underline">
            {copy.seeAll}
          </Link>
          {count > 1 && (
            <Button variant="ghost" size="icon" aria-label={copy.next} title={copy.next} onClick={next}>
              <span aria-hidden>›</span>
            </Button>
          )}
        </div>
        <TrayBody entry={entry} asker={asker} hobs={hobs} via={via} />
      </section>
    </section>
  );
}

/** The hob an entry comes from: the one that asked, or whose work is stuck. */
const askerOf = (entry: TrayEntry) =>
  entry.kind === "approval"
    ? entry.request.agentId
    : entry.kind === "stuck"
      ? entry.item.recipientId
      : entry.waiting.question.askerId;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** What the item is called, the same as its card elsewhere. */
const itemLabel = (entry: TrayEntry, asker: Hob): string => {
  if (entry.kind === "approval") return approvalCopy.asks({ name: asker.name });
  if (entry.kind === "stuck") return blockerCopy.label({ name: asker.name, what: blockerWhat(entry.item) });
  return questionCopy.asks({ name: asker.name });
};

const titleOf = (entry: TrayEntry, asker: Hob): string => {
  if (entry.kind === "approval")
    return copy.approvalTitle({ name: asker.name, action: lowerFirst(operationLabel(entry.request.operation)) });
  return entry.kind === "stuck" ? copy.stuckTitle({ name: asker.name }) : copy.questionTitle({ name: asker.name });
};

function TrayBody({
  entry,
  asker,
  hobs,
  via,
}: {
  entry: TrayEntry;
  asker: Hob;
  hobs: HobLookup;
  via: ApprovalSurface;
}) {
  if (entry.kind === "approval") return <ApprovalBody entry={entry} asker={asker} via={via} />;
  if (entry.kind === "stuck") return <StuckBody entry={entry} asker={asker} />;
  const { question, task } = entry.waiting;
  return (
    <>
      <p className="m-0 whitespace-pre-wrap text-text">{question.text}</p>
      <AnswerForm question={question} askerName={asker.name} via={via} />
      <Details summary={copy.details.question}>
        {copy.passedUp({
          names: [asker.name, ...question.chain.map((id) => hobs(id).name)],
          task: taskTitle(task),
          when: formatWhen(question.createdAt),
        })}
      </Details>
    </>
  );
}

function ApprovalBody({
  entry,
  asker,
  via,
}: {
  entry: Extract<TrayEntry, { kind: "approval" }>;
  asker: Hob;
  via: ApprovalSurface;
}) {
  const { request } = entry;
  const decide = useDecideApproval(request, via);
  return (
    <>
      <p className="m-0 text-text">{request.reason}</p>
      <div className="flex gap-2 rounded-tag bg-deep px-3 py-2 font-mono text-code">
        <span aria-hidden className="text-label">
          $
        </span>
        <code className="break-all whitespace-pre-wrap text-text-strong">{exactAction(request)}</code>
      </div>
      <ApprovalActions
        approval={request}
        hob={asker}
        pending={decide.isPending}
        onDecide={(decision) => decide.mutate(decision)}
        look="tray"
      />
      {decide.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {decisionErrorText(decide.error)}
        </p>
      )}
      <Details summary={copy.details.approval}>
        <span className="flex flex-col gap-1">
          <span>
            {approvalCopy.targetLine({
              target: request.targets.length === 0 ? approvalCopy.noTarget : request.targets.join(", "),
            })}
          </span>
          <span>{approvalCopy.askedByLine({ chain: approvalCopy.chain({ name: asker.name }) })}</span>
          <span>{approvalCopy.riskLine({ risk: approvalCopy.riskOf[request.operation] })}</span>
          <span>{expiryText(request)}</span>
        </span>
      </Details>
    </>
  );
}

function StuckBody({ entry, asker }: { entry: Extract<TrayEntry, { kind: "stuck" }>; asker: Hob }) {
  const choice = blockerChoice(entry.item, asker);
  if (choice === null) return null;
  return (
    <>
      <p className="m-0 text-text">{blockerWhat(entry.item)}</p>
      <BlockerChoices item={entry.item} hob={asker} held={false} />
      <Details summary={copy.details.stuck}>
        {blockerWhy(entry.item, choice.blocker, asker.name)}
        {choice.blocker.diagnostic !== null && (
          <span className="mt-1 block font-mono break-words">{choice.blocker.diagnostic}</span>
        )}
      </Details>
    </>
  );
}

function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="text-detail">
      <summary className="cursor-pointer text-label">{summary}</summary>
      <div className="mt-2 text-text-secondary">{children}</div>
    </details>
  );
}
