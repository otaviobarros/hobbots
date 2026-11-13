import type { ApprovalRequest, ApprovalSurface, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { formatWhen } from "../../lib/time.ts";
import { blockerWhat } from "../blockers/blocker-model.ts";
import { messages as blockerCopy } from "../blockers/messages.ts";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { HobProposalCard } from "../hob-proposal/hob-proposal-card.tsx";
import { hobProposalWhat } from "../hob-proposal/hob-proposal-model.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages as inboxCopy } from "../inbox/messages.ts";
import { messages as appCopy } from "../messages.ts";
import { WAITS } from "../move-on/places.ts";
import { approvalAction } from "../plain-words/plain-words.ts";
import { AnswerForm } from "../quest/answer-form.tsx";
import { messages as questMessages } from "../quest/messages.ts";
import { type HobLookup, useHobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { webAskOf } from "../web/web-ask.ts";
import { ApprovalBody } from "./approval-body.tsx";
import { Details } from "./details.tsx";
import { HubQuestionBody } from "./hub-question-body.tsx";
import { messages } from "./messages.ts";
import { StuckBody } from "./stuck-body.tsx";
import { shownEntry, type TrayEntry } from "./tray-entries.ts";
import { trayTargets } from "./tray-focus.ts";

const copy = messages;
const approvalCopy = appCopy.approval;
const questionCopy = questMessages.question;

type Hob = ReturnType<HobLookup>;

/**
 * Everything waiting on you, one item at a time, right above the composer: approvals and hob
 * proposals, then stuck work, then questions. "1 of 2" and Next step through them; deciding one shows the next. The
 * high-risk variant has a rose edge and its confirm box. Gone when nothing waits. The chat and Home
 * pass the entries they hold, and `via` names the surface a decision made here records. Focus that
 * was on a decided item moves to the next one, or out of the tray once nothing waits (#995). A chat
 * or camp passes its scope control in `scope`, `where` names where an entry from elsewhere waits, and
 * `inboxIn` opens the Inbox on that chat or camp (#1423).
 */
export function NeedsTray({
  entries,
  via = "chat",
  scope,
  where = nowhere,
  inboxIn,
}: {
  entries: ReadonlyArray<TrayEntry>;
  via?: ApprovalSurface;
  scope?: ReactNode;
  where?: (entry: TrayEntry) => ReactNode;
  inboxIn?: ThreadId | undefined;
}) {
  const hobs = useHobLookup();
  const [place, setPlace] = useState<{ key: string | undefined; index: number }>({ key: undefined, index: 0 });
  const shown = shownEntry(entries, place.key, place.index);
  if (shown === undefined) return null;
  const { entry, index } = shown;
  const count = entries.length;
  const { risky, stuck } = toneOf(entry);
  const next = () => {
    const after = entries[(index + 1) % count];
    setPlace({ key: after?.key, index: (index + 1) % count });
  };
  const asker = askerOf(entry, hobs);
  return (
    <section
      data-tray=""
      aria-label={copy.label({ index: index + 1, count })}
      className={cn(
        "cut flex animate-hb-in gap-3 border-(length:--edge) bg-card p-4",
        risky || stuck ? "border-rose" : "border-lantern",
      )}
    >
      {/* A new item hops its hob in the looks that hop, and fades in in the others. */}
      <span
        key={entry.key}
        className="flex size-hob-tile shrink-0 animate-hb-in items-center justify-center self-start rounded-tile bg-tile [&_.sprite]:[animation:var(--hop)]"
      >
        {"lookSeed" in asker ? <HobSprite hob={asker} size={28} /> : <ChiefMark size={28} mood="needs-you" />}
      </span>
      <section
        key={`${entry.key}-body`}
        {...WAITS}
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
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 min-w-0 flex-1 font-heading text-title font-bold text-text-strong">
            {titleOf(entry, asker)}
          </h2>
          {count > 1 && (
            <span className="rounded-tag bg-line px-2 text-meta text-label">
              {copy.position({ index: index + 1, count })}
            </span>
          )}
          {scope}
          <Link to="/inbox" search={inboxSearch(inboxIn)} className="text-detail text-text-strong underline">
            {copy.seeAll}
          </Link>
          {count > 1 && (
            <Button variant="ghost" size="icon" aria-label={copy.next} title={copy.next} onClick={next}>
              <span aria-hidden>›</span>
            </Button>
          )}
        </div>
        {where(entry)}
        <TrayBody entry={entry} asker={asker} hobs={hobs} via={via} />
      </section>
    </section>
  );
}

/** No line naming where an entry waits, on Home, where everything shows. */
const nowhere = () => null;

/** Whether an entry is a high-risk ask, or stuck work: both edge the tray in rose. */
const toneOf = (entry: TrayEntry) => ({
  risky:
    (entry.kind === "approval" && entry.request.onceOnly) ||
    (entry.kind === "hob-proposal" && entry.hobs.proposal.highRisk),
  stuck: entry.kind === "stuck",
});

/** See all in Inbox's address: Needs you, on the tray's chat or camp when it has one. */
const inboxSearch = (inboxIn: ThreadId | undefined) =>
  inboxIn === undefined ? { tab: "needs" as const } : { tab: "needs" as const, in: inboxIn };

/** Who asks for a question the hub itself puts to you (#976): the hub, shown as the chief. */
const HUB = { name: inboxCopy.row.hub } as const;

/** Who an entry comes from: the hob that asked, or whose work is stuck, or the hub. */
const askerOf = (entry: TrayEntry, hobs: HobLookup): Hob | typeof HUB => {
  switch (entry.kind) {
    case "approval":
      return hobs(entry.request.agentId);
    case "stuck":
      return hobs(entry.item.recipientId);
    case "question":
      return hobs(entry.waiting.question.askerId);
    case "hob-proposal":
      return hobs(entry.hobs.proposal.agentId);
    default:
      return HUB;
  }
};

/** What the item is called, the same as its card elsewhere. */
const itemLabel = (entry: TrayEntry, asker: Pick<Hob, "name">): string => {
  if (entry.kind === "approval") return approvalCopy.asks({ name: asker.name });
  if (entry.kind === "hob-proposal") return hobProposalWhat(entry.hobs.proposal, asker.name);
  if (entry.kind === "stuck") return blockerCopy.label({ name: asker.name, what: blockerWhat(entry.item) });
  return questionCopy.asks({ name: asker.name });
};

/** An approval's title: its web card's when it asks about the web (ADR 036), else what it asks to do. */
const approvalTitle = (request: ApprovalRequest, name: string): string =>
  webAskOf(request, name)?.title ?? copy.approvalTitle({ name, action: approvalAction(request) });

const titleOf = (entry: TrayEntry, asker: Pick<Hob, "name">): string => {
  if (entry.kind === "approval") return approvalTitle(entry.request, asker.name);
  if (entry.kind === "hob-proposal") return hobProposalWhat(entry.hobs.proposal, asker.name);
  return entry.kind === "stuck" ? copy.stuckTitle({ name: asker.name }) : copy.questionTitle({ name: asker.name });
};

function TrayBody({
  entry,
  asker,
  hobs,
  via,
}: {
  entry: TrayEntry;
  asker: Pick<Hob, "name">;
  hobs: HobLookup;
  via: ApprovalSurface;
}) {
  if (entry.kind === "approval") return <ApprovalBody entry={entry} asker={hobs(entry.request.agentId)} via={via} />;
  if (entry.kind === "stuck") return <StuckBody entry={entry} asker={hobs(entry.item.recipientId)} />;
  if (entry.kind === "hub-question") return <HubQuestionBody question={entry.question} via={via} />;
  // The same card as in the Inbox, its title the tray's (ADR 034, Asking is a proposal).
  if (entry.kind === "hob-proposal")
    return <HobProposalCard view={entry.hobs} who={asker.name} bare targets={trayTargets} />;
  const { question, task } = entry.waiting;
  return (
    <>
      <p className="m-0 whitespace-pre-wrap text-text">{question.text}</p>
      <AnswerForm question={question} askerName={asker.name} via={via} targets={trayTargets} />
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
