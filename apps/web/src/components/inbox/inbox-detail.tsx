import type { WaitingDevice, WaitingQuestion } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type ApprovalRequest,
  type BackpackItem,
  exactAction,
  type FailedTask,
  type HubQuestion,
  type MemoryShare,
  type PolicyOperation,
  type Quest,
  type TaskId,
  type ThreadId,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTaskControl } from "../../api/task-controls.ts";
import { firstLine } from "../../lib/format.ts";
import { formatWhen } from "../../lib/time.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { ApprovalDecision } from "../approvals/approval-card.tsx";
import { BlockerChoices, blockerChoice } from "../blockers/blocker-choices.tsx";
import { blockerWhat, blockerWhy } from "../blockers/blocker-model.ts";
import { messages as blockerCopy } from "../blockers/messages.ts";
import { ShareDecision, ShareDiff } from "../memory/share-card.tsx";
import { scopeName } from "../memory/memory-model.ts";
import { messages as memoryCopy } from "../memory/messages.ts";
import { shareDestination } from "../memory/review-model.ts";
import { messages as appCopy } from "../messages.ts";
import { DeviceFacts, MatchingCode, PairingActions } from "../pairing/device-request.tsx";
import { messages as pairingCopy } from "../pairing/messages.ts";
import { AnswerForm, HubAnswerForm } from "../quest/answer-form.tsx";
import { controlError } from "../quest/control-room.ts";
import { useHobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { roomSearch } from "../quest-room/room-search.ts";
import { EntryPortrait } from "./entry-portrait.tsx";
import { entryRow, entryThread, type InboxEntry, type InboxRow } from "./inbox-entries.ts";
import { InboxIcon } from "./inbox-icons.tsx";
import { expiryText } from "./inbox-items.ts";
import { messages } from "./messages.ts";
import type { InboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

/** What the detail pane needs besides the entry: names for hobs and threads, and each Task's quest. */
interface DetailContext {
  readonly directory: InboxDirectory;
  readonly questOf: (taskId: TaskId) => Quest | undefined;
  readonly now: Date;
}

/**
 * One entry in full beside the list, the same shape for every kind: who asked as a chain with the
 * kind, what it asks as the title and why, then its facts (Quest, Thread, Asked by, When) and the
 * kind's own controls, with Open in the chat when it has a thread. A request shows its exact action
 * once, then decides with the chat's own buttons and high-risk check, so deciding here works exactly
 * as it does there (ADR 015); each fact shows once.
 */
export function EntryDetail({ entry, hob, ...context }: { entry: InboxEntry; hob: Agent | undefined } & DetailContext) {
  const thread = entryThread(entry);
  const lead = thread === null ? undefined : context.directory.threadHob(thread);
  const row = entryRow(entry, context.directory.hobName, lead, context.now);
  switch (entry.kind) {
    case "approval":
      return hob === undefined ? null : <ApprovalDetail request={entry.request} hob={hob} row={row} {...context} />;
    case "question":
      return <QuestionDetail waiting={entry.waiting} hob={hob} row={row} {...context} />;
    case "hub-question":
      // Keyed by the entry, so a draft or a failed send for one question never shows on the next.
      return <HubQuestionDetail key={entry.key} question={entry.question} row={row} {...context} />;
    case "stuck":
      return <StuckDetail item={entry.item} hob={hob} row={row} {...context} />;
    case "failed":
      // Keyed by the entry, so a Retry sent from one failed Task never shows on the next.
      return <FailedDetail key={entry.key} failed={entry.failed} hob={hob} row={row} lead={lead} {...context} />;
    case "memory":
      return <ShareDetail key={entry.key} share={entry.share} hob={hob} row={row} {...context} />;
    default:
      return <DeviceDetail device={entry.device} row={row} now={context.now} />;
  }
}

function ApprovalDetail({
  request,
  hob,
  row,
  directory,
  questOf,
  now,
}: { request: ApprovalRequest; hob: Agent; row: InboxRow } & DetailContext) {
  const pending = request.state === "pending";
  // A party member asks in its lead's thread, whose hob is known only once the threads load.
  const chatHob = directory.threadHob(request.threadId) ?? (request.messageId !== null ? request.agentId : undefined);
  const task = request.taskId ?? request.rootTaskId;
  const expiry = pending ? expiryText(request.expiresAt, now) : "";
  const asked = formatWhen(request.createdAt, now);
  return (
    <DetailFrame
      label={copy.detail.label({ name: hob.name, action: row.what })}
      portrait={<EntryPortrait hob={hob} device={false} waiting={pending} large />}
      row={row}
      why={request.reason}
      foot={footText(request, hob.name)}
      chat={
        hob.status === "retired"
          ? undefined
          : chatLink(chatHob, request.threadId, request.messageId === null ? null : { messageId: request.messageId })
      }
    >
      <ActionBlock action={exactAction(request)} command={COMMANDS.has(request.operation)} />
      <Facts
        rows={[
          [copy.detail.quest, questName(task === null ? undefined : questOf(task), directory)],
          [copy.detail.thread, directory.threadTitle(request.threadId)],
          [copy.detail.askedBy, row.chain.join(copy.row.arrow)],
          [copy.detail.when, expiry === "" ? asked : copy.detail.whenExpires({ asked, expiry }), row.tone === "urgent"],
          [copy.detail.decided, request.decidedAt === null ? undefined : formatWhen(request.decidedAt, now)],
        ]}
      />
      <section aria-label={appCopy.approval.asks({ name: hob.name })} data-state={request.state}>
        <ApprovalDecision approval={request} hob={hob} via="inbox" look="tray" keys />
      </section>
    </DetailFrame>
  );
}

/** The operations whose exact action is a command line, shown after a prompt sign. */
const COMMANDS: ReadonlySet<PolicyOperation> = new Set(["run-commands", "local-git", "push"]);

/** The exact action on the deep ground, with Copy: a command after a `$`, or the address or file as it is. */
function ActionBlock({ action, command }: { action: string; command: boolean }) {
  const [state, copyText] = useCopy();
  const said = state === "copied" ? copy.detail.copied : state === "failed" ? copy.detail.copyFailed : "";
  return (
    <div className="flex items-center gap-2 rounded-control border border-line bg-deep py-1 ps-3.5 pe-1">
      {command && (
        <span aria-hidden className="font-mono text-code text-label">
          $
        </span>
      )}
      <code className="min-w-0 flex-1 py-1.5 font-mono text-code break-all whitespace-pre-wrap text-moonlight">
        {action}
      </code>
      <Button
        variant="ghost"
        size="icon"
        aria-label={copy.detail.copy}
        title={said || copy.detail.copy}
        onClick={() => copyText(action)}
      >
        <InboxIcon name="copy" />
      </Button>
      {/* Polite, not a status: the decision's line is the detail's one status. */}
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}

function QuestionDetail({
  waiting,
  hob,
  row,
  directory,
  questOf,
  now,
}: { waiting: WaitingQuestion; hob: Agent | undefined; row: InboxRow } & DetailContext) {
  const { question, task } = waiting;
  const asker = directory.hobName(question.askerId);
  // The top lead is the last to pass it up, and your answer goes back through it. The chat it opens
  // is that lead's, or the asker's own when nobody leads it.
  const lead = question.chain.at(-1);
  const chatHob = lead ?? question.askerId;
  return (
    <DetailFrame
      label={copy.question.label({ name: asker })}
      portrait={<EntryPortrait hob={hob} device={false} waiting large />}
      row={{ ...row, what: copy.question.title({ name: asker }) }}
      why={
        question.chain.length > 0
          ? copy.question.passedBy({ names: question.chain.map(directory.hobName) })
          : copy.question.direct
      }
      chat={chatLink(chatHob, task.threadId, { taskId: task.id }, copy.detail.openRoom)}
    >
      <div className="flex items-start gap-3">
        <EntryPortrait hob={hob} device={false} waiting={false} />
        <blockquote className="m-0 min-w-0 flex-1 rounded-[4px_14px_14px_14px] bg-card px-4 py-3 text-reading leading-normal whitespace-pre-wrap text-text-strong [overflow-wrap:anywhere]">
          {question.text}
        </blockquote>
      </div>
      <Facts
        rows={[
          [copy.detail.quest, questName(questOf(task.id), directory)],
          [copy.detail.task, taskTitle(task)],
          [copy.detail.passedUpBy, row.chain.join(copy.row.arrow)],
          [copy.detail.when, formatWhen(question.createdAt, now)],
        ]}
      />
      <AnswerForm
        question={question}
        askerName={asker}
        via="inbox"
        hint={
          lead === undefined
            ? copy.question.goesStraight({ name: asker })
            : copy.question.goesBack({ name: directory.hobName(lead) })
        }
      />
    </DetailFrame>
  );
}

/**
 * A question the hub itself asks you (#976): about a subject the hub names, not a Task, so it
 * passed no lead. Your answer goes to the hub, which applies it.
 */
function HubQuestionDetail({
  question,
  row,
  directory,
  now,
}: { question: HubQuestion; row: InboxRow } & DetailContext) {
  const hub = copy.row.hub;
  return (
    <DetailFrame
      label={copy.question.label({ name: hub })}
      portrait={<EntryPortrait hob={undefined} device={false} hub waiting large />}
      row={{ ...row, what: copy.question.title({ name: hub }) }}
      why={copy.question.fromHub}
      chat={question.chat === null ? undefined : chatLink(question.chat.agentId, question.chat.threadId, null)}
    >
      <div className="flex items-start gap-3">
        <EntryPortrait hob={undefined} device={false} hub waiting={false} />
        <blockquote className="m-0 min-w-0 flex-1 rounded-[4px_14px_14px_14px] bg-card px-4 py-3 text-reading leading-normal whitespace-pre-wrap text-text-strong [overflow-wrap:anywhere]">
          {question.text}
        </blockquote>
      </div>
      <Facts
        rows={[
          [copy.detail.about, question.subject.title],
          [copy.detail.thread, question.chat === null ? undefined : directory.threadTitle(question.chat.threadId)],
          [copy.detail.when, formatWhen(question.createdAt, now)],
        ]}
      />
      <HubAnswerForm
        question={question}
        askerName={copy.row.hubInSentence}
        via="inbox"
        hint={copy.question.goesToHub}
      />
    </DetailFrame>
  );
}

function StuckDetail({
  item,
  row,
  directory,
  questOf,
}: { item: BackpackItem; hob: Agent | undefined; row: InboxRow } & DetailContext) {
  const hobs = useHobLookup();
  const hob = hobs(item.recipientId);
  const choice = blockerChoice(item, hob);
  if (choice === null) return null;
  return (
    <DetailFrame
      label={blockerCopy.label({ name: hob.name, what: blockerWhat(item) })}
      portrait={<EntryPortrait hob={directory.hob(item.recipientId)} device={false} waiting large />}
      row={{ ...row, what: blockerCopy.title({ name: hob.name }) }}
      why={blockerWhy(item, choice.blocker, hob.name)}
      chat={chatLink(
        item.recipientId,
        item.threadId,
        item.taskId === null ? null : { taskId: item.taskId },
        item.taskId === null ? copy.detail.openChat : copy.detail.openRoom,
      )}
    >
      {choice.blocker.diagnostic !== null && (
        <p className="m-0 text-meta break-words text-label">
          {blockerCopy.diagnostic} <span className="font-mono">{choice.blocker.diagnostic}</span>
        </p>
      )}
      <Facts
        rows={[
          [copy.detail.quest, questName(item.taskId === null ? undefined : questOf(item.taskId), directory)],
          [copy.detail.work, row.what],
          [copy.detail.thread, item.threadId === null ? undefined : directory.threadTitle(item.threadId)],
          [copy.detail.tries, row.when],
        ]}
      />
      <p className="m-0 text-ui font-bold text-lantern">{blockerCopy.next[choice.next]}</p>
      <div className="flex flex-col gap-2">
        <BlockerChoices item={item} hob={hob} />
      </div>
    </DetailFrame>
  );
}

/**
 * A party member's Task that failed while its Quest goes on: Retry sends it back to its hob from
 * here, and Open the task opens the Quest room beside its lead's chat on that Task's lane, where it
 * can go to another hob or be cancelled. A retry the hub recorded takes the entry out of the list with its event.
 */
function FailedDetail({
  failed,
  hob,
  row,
  lead,
  directory,
  questOf,
  now,
}: { failed: FailedTask; hob: Agent | undefined; row: InboxRow; lead: AgentId | undefined } & DetailContext) {
  const { task } = failed;
  const owner = directory.hobName(task.ownerId);
  const leadId = failed.leadId ?? lead ?? task.ownerId;
  const retry = useTaskControl();
  return (
    <DetailFrame
      label={copy.failedTask.label({ name: owner, what: row.what })}
      portrait={<EntryPortrait hob={hob} device={false} waiting large />}
      row={{ ...row, what: copy.failedTask.title({ name: owner }) }}
      why={copy.failedTask.why({ lead: directory.hobName(leadId) })}
      chat={chatLink(leadId, task.threadId, null)}
    >
      <Facts
        rows={[
          [copy.detail.quest, questName(questOf(task.id), directory)],
          [copy.detail.task, row.what],
          [copy.detail.thread, task.threadId === null ? undefined : directory.threadTitle(task.threadId)],
          [copy.detail.when, formatWhen(task.updatedAt, now)],
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          disabled={retry.isPending || retry.isSuccess}
          onClick={() => retry.mutate({ kind: "retry", taskId: task.id })}
        >
          {retry.isPending ? copy.failedTask.retrying : copy.failedTask.retry}
        </Button>
        {task.threadId !== null && (
          <Button variant="outline" asChild>
            <Link
              to="/hobs/$hobId/threads/$threadId"
              params={{ hobId: leadId, threadId: task.threadId }}
              search={roomSearch(task.id)}
              className="no-underline"
            >
              {copy.failedTask.openTask}
            </Link>
          </Button>
        )}
      </div>
      <p role="status" className="m-0 text-meta text-text-secondary empty:hidden">
        {retry.isSuccess ? copy.failedTask.retried({ name: owner }) : null}
      </p>
      {retry.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {controlError(retry.error, { owner, target: owner })}
        </p>
      )}
    </DetailFrame>
  );
}

function DeviceDetail({ device, row, now }: { device: WaitingDevice; row: InboxRow; now: Date }) {
  return (
    <DetailFrame
      label={pairingCopy.prompt.label({ name: device.request.name })}
      portrait={<EntryPortrait hob={undefined} device waiting large />}
      row={row}
      why={copy.detail.deviceWhy({ name: device.request.name })}
      foot={copy.detail.deviceFoot}
    >
      <MatchingCode device={device} />
      <div className="rounded-card bg-card px-4 py-1 [&_dl>div:last-child]:border-b-0">
        <DeviceFacts device={device} now={now} />
      </div>
      <PairingActions device={device} canDefer />
    </DetailFrame>
  );
}

/**
 * A hob asking to share what it learned (ADR 028): where it would go, the page it would add, and
 * Share it, Keep it private, or Edit in Memory, which opens it in Memory › To review. Once decided
 * it stays open with what happened, and Undo for a share that went through.
 */
function ShareDetail({
  share,
  hob,
  row,
  directory,
  now,
}: { share: MemoryShare; hob: Agent | undefined; row: InboxRow } & DetailContext) {
  const hobs = new Map(hob === undefined ? [] : [[hob.id, hob] as const]);
  const who = directory.hobName(share.agentId);
  return (
    <DetailFrame
      label={copy.detail.shareLabel({ name: who })}
      portrait={<EntryPortrait hob={hob} device={false} waiting={row.tag === "needs-you"} large />}
      row={row}
      why={memoryCopy.review.route({ who, destination: shareDestination(share, hobs) })}
      chat={chatLink(share.agentId, share.threadId, share.messageId === null ? null : { messageId: share.messageId })}
      foot={
        share.scope._tag === "Project"
          ? memoryCopy.review.footProject({ name: scopeName(share.scope, hobs) })
          : memoryCopy.review.footEveryone
      }
    >
      <h3 className="lbl m-0 text-label">{copy.detail.shareDiff}</h3>
      <ShareDiff share={share} hobs={hobs} />
      <Facts
        rows={[
          [memoryCopy.review.facts.suggestedBy, `${who} · ${formatWhen(share.createdAt, now)}`],
        ]}
      />
      <ShareDecision share={share} hobs={hobs} edit="in-memory" />
    </DetailFrame>
  );
}

/** The frame every kind shares: who asked, the kind, the title and why, then the kind's own parts. */
/**
 * The detail's frame while the entry is read: the portrait, the chain and the tag, the title and
 * the reason in skeleton, where the entry lands, so the column keeps its shape.
 */
export function DetailSkeleton() {
  return (
    <article aria-busy="true" className="flex max-w-170 flex-col gap-4 px-8 pt-6 pb-8">
      <header aria-hidden className="flex flex-col gap-2.5">
        <span className="flex items-center gap-3">
          <Skeleton shape="tile" className="size-11" />
          <span className="flex-1 text-ui">
            <Skeleton width="20ch" className="max-w-full" />
          </span>
          <Skeleton shape="block" width="8ch" />
        </span>
        <span className="font-heading text-display">
          <Skeleton width="24ch" className="max-w-full" />
        </span>
        <Skeleton width="40ch" className="max-w-full" />
      </header>
    </article>
  );
}

function DetailFrame({
  label,
  portrait,
  row,
  why,
  chat,
  foot = "",
  children,
}: {
  label: string;
  portrait: ReactNode;
  row: InboxRow;
  why: string;
  chat?: ReactNode;
  foot?: string;
  children: ReactNode;
}) {
  return (
    <article aria-label={label} className="flex max-w-170 animate-hb-in flex-col gap-4 px-8 pt-6 pb-8">
      <header className="flex flex-col gap-2.5">
        <span className="flex items-center gap-3">
          {portrait}
          <Chain names={row.chain} />
          <Badge variant={row.tag}>{row.kind}</Badge>
        </span>
        <h2 className="m-0 font-heading text-display font-bold text-text-strong [overflow-wrap:anywhere]">
          {row.what}
        </h2>
        <p className="m-0 text-text">{why}</p>
      </header>
      {children}
      {(chat !== undefined || foot !== "") && (
        <div className="flex flex-wrap items-center gap-4 pt-1 text-ui">
          {chat}
          {foot !== "" && <span className="text-detail text-label">{foot}</span>}
        </div>
      )}
    </article>
  );
}

/** Who asked, as linked names: "You → Aldric → Ada", the one that asked stressed. */
function Chain({ names }: { names: ReadonlyArray<string> }) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      <span className="sr-only">{names.join(copy.row.arrow)}</span>
      {names.map((name, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a chain can name the same hob twice, in order.
        <span key={index} aria-hidden="true" className="flex items-center gap-1">
          {index > 0 && <span className="text-label">→</span>}
          <span
            className={
              index === names.length - 1
                ? "rounded-tag bg-line px-2 text-detail font-semibold text-text-strong"
                : "rounded-tag bg-hover px-2 text-detail text-text-secondary"
            }
          >
            {name}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The entry's facts as a card of term and value; a row with no value is left out, and a row marked
 * urgent shows its value in lantern.
 */
function Facts({ rows }: { rows: ReadonlyArray<readonly [string, string | undefined, boolean?]> }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,140px)_1fr] rounded-card bg-card px-4 py-1 text-ui">
      {rows
        .filter((fact): fact is readonly [string, string, boolean?] => fact[1] !== undefined && fact[1] !== "")
        .map(([term, value, urgent]) => (
          <div key={term} className="contents [&:last-child>*]:border-b-0">
            <dt className="border-b border-line py-2.5 pe-3 text-label">{term}</dt>
            <dd className={cn("m-0 border-b border-line py-2.5 [overflow-wrap:anywhere]", urgent && "text-lantern")}>
              {value}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * Open in the chat, for an entry whose thread and chat are known. An entry about a Task opens the
 * Quest room beside that chat instead, with the Task's lane lit (ADR 027).
 */
const chatLink = (
  hobId: AgentId | undefined,
  threadId: ThreadId | null,
  at: { readonly messageId: string } | { readonly taskId: string } | null,
  label: string = copy.detail.openChat,
): ReactNode =>
  hobId === undefined || threadId === null ? undefined : (
    <Link
      to="/hobs/$hobId/threads/$threadId"
      params={{ hobId, threadId }}
      search={at === null ? {} : "taskId" in at ? roomSearch(at.taskId) : { message: at.messageId }}
      className="-ms-2 inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-link no-underline hover:bg-hover"
    >
      <InboxIcon name="chat" />
      {label}
    </Link>
  );

/** A quest's name for the facts: its lead's quest and its goal. */
const questName = (quest: Quest | undefined, directory: InboxDirectory): string | undefined =>
  quest === undefined
    ? undefined
    : copy.questGroup({ name: directory.hobName(quest.leadId), goal: firstLine(quest.goal) });

/**
 * What the line under a request says: why an expired one cannot be approved, what Allow once covers
 * for a high-risk one, or what happens if it expires.
 */
const footText = (request: ApprovalRequest, name: string): string => {
  if (request.state === "expired") return copy.detail.expiredFoot;
  if (request.state !== "pending") return "";
  return request.onceOnly ? copy.detail.onceOnlyFoot : copy.detail.pendingFoot({ name });
};
