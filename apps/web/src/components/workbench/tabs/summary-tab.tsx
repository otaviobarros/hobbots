import { AgentId, type ArtifactRef, isLiveAttempt, TASK_TOOLS, type TaskId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@hobbots/ui/components/collapsible";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { approvalsQuery } from "../../../api/approvals.ts";
import { useBackpack } from "../../../api/backpack.ts";
import { useBlockersQuery } from "../../../api/blockers.ts";
import { formatCount } from "../../../lib/format.ts";
import { bothRead, waitingView } from "../../backpack/backpack-model.ts";
import { WaitingList } from "../../backpack/waiting-list.tsx";
import { useNow } from "../../inbox/use-now.ts";
import { type HobLookup, useOpenTask } from "../../quest/use-work.ts";
import { taskTitle } from "../../quest/work-model.ts";
import { messages } from "../messages.ts";
import { useOpenWorkbench, useWorkbenchMoves } from "../use-workbench.ts";
import type { WorkbenchTab } from "../workbench-model.ts";
import {
  type HappenedLine,
  type Mark,
  type Summary,
  type SummaryLine,
  subtreeScope,
  summaryOf,
} from "./summary-model.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const copy = messages.summary;

/** Changed files listed before the rest fold into one link to Changes. */
const CHANGES_SHOWN = 6;

const GLYPH: Readonly<Record<Mark, string>> = {
  done: "✓",
  failed: "✕",
  waiting: "◷",
  running: "●",
  next: "›",
  cancelled: "■",
  unresolved: "!",
};

const GLYPH_TONE: Readonly<Record<Mark, string>> = {
  done: "bg-line text-mint",
  failed: "bg-line text-rose",
  waiting: "bg-line text-text-secondary",
  running: "bg-line text-mint",
  next: "bg-line text-label",
  cancelled: "bg-line text-text-secondary",
  unresolved: "bg-rose text-on-rose",
};

/**
 * The Summary tab (ADR 023), from the hub's records with no model call: one plain line on where
 * the Task stands, then what happened as a timeline card, then buttons to the views the Task used.
 * What it made and what is still open follow, and what it was asked waits behind Details. A
 * question for you on this Task shows only in the task chat, where you answer it.
 */
export function SummaryTab({ tree, task, attempt, activity, hobs, onTab }: WorkbenchTabProps) {
  const route = useParams({ strict: false });
  const hobId = AgentId.make(route.hobId ?? "");
  const threadId = ThreadId.make(route.threadId ?? "");
  const openWorkbench = useOpenWorkbench(hobId, threadId);
  const openTask = useOpenTask(hobId, threadId);
  const toChat = useTaskChat(tree, hobId, threadId);
  const reads = useOpenReads(task.threadId);
  const summary = summaryOf(tree, task, attempt, activity, reads.approvals);
  const owner = hobs(task.ownerId).name;
  const running = attempt !== null && isLiveAttempt(attempt.state);
  return (
    <div data-slot="summary" className="flex max-w-3xl flex-col gap-4 px-5 py-4">
      <Line line={summary.line} owner={owner} hobs={hobs} />
      <Timeline summary={summary} owner={owner} running={running} hobs={hobs} onOpen={(id) => openWorkbench(id)} />
      <TabButtons used={summary.used} onTab={onTab} />
      <Section title={copy.made}>
        <Made
          summary={summary}
          owner={owner}
          running={running}
          reading={attempt !== null && activity === null}
          onTab={onTab}
        />
      </Section>
      <Section title={copy.open}>
        <StillOpen
          summary={summary}
          tree={tree}
          task={task}
          hobs={hobs}
          reads={reads}
          onChat={toChat}
          onTask={openTask}
        />
      </Section>
      <Asked asked={summary.asked} hobs={hobs} />
    </div>
  );
}

/** The line Summary leads with: the Task's result, or where the Attempt shown stands. */
function Line({ line, owner, hobs }: { line: SummaryLine; owner: string; hobs: HobLookup }) {
  const lead = (() => {
    switch (line.kind) {
      case "result":
        return line.summary;
      case "not-started":
        return copy.line.notStarted({ name: owner });
      case "asks":
        return copy.line.asks({ name: hobs(line.asker).name });
      case "working":
        return copy.line.working({ name: owner, number: line.attempt });
      case "waiting":
        return copy.line.waiting({ name: owner, number: line.attempt });
      case "ended":
        return copy.line.ended[line.mark]({ number: line.attempt });
      case "no-result":
        return copy.noResult;
    }
  })();
  return (
    <div data-slot="summary-line" className="flex flex-col gap-1">
      <p className="m-0 text-body whitespace-pre-wrap text-text-strong">
        {lead}
        {line.earlier > 0 && ` ${copy.line.earlier({ count: line.earlier })}`}
      </p>
      {line.kind === "result" && line.from !== null && (
        <span className="text-meta text-label">{copy.resultFrom({ number: line.from })}</span>
      )}
    </div>
  );
}

/** What happened, as a card of lines, each led by its mark's glyph, the glyphs joined by a line. */
function Timeline({
  summary,
  owner,
  running,
  hobs,
  onOpen,
}: {
  summary: Summary;
  owner: string;
  running: boolean;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const lines = summary.happened;
  return (
    <section
      aria-label={copy.happened}
      className="flex flex-col gap-2 rounded-card border-(length:--edge) border-line bg-card px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2 px-2.5">
        <h3 className="lbl m-0 text-meta text-label">{copy.happened}</h3>
        {lines.length > 0 && (
          <span aria-hidden className="rounded-dot bg-line px-1.5 text-meta text-label">
            {formatCount(lines.length)}
          </span>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="m-0 px-2.5 text-detail text-text-secondary">
          {running ? copy.nothingYet({ name: owner }) : copy.nothingHappened({ name: owner })}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {lines.map((line, index) => (
            <li key={lineKey(line)} className="relative">
              {index < lines.length - 1 && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute start-5 top-6.5 -bottom-1.5 w-(--edge) -translate-x-1/2 bg-line-2 rtl:translate-x-1/2"
                />
              )}
              <Happened line={line} hobs={hobs} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** What the Task was asked, folded behind Details: the brief, and what the lead expects back. */
function Asked({ asked, hobs }: { asked: Summary["asked"]; hobs: HobLookup }) {
  const title = asked.from === null ? copy.asked : copy.askedBy({ name: hobs(asked.from).name });
  return (
    <Collapsible>
      <div className="flex flex-col gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="text" size="xs" className="-ms-2 self-start">
            {copy.details}
            <span aria-hidden className="in-data-[state=open]:rotate-90">
              ›
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Section title={title}>
            <div className="flex flex-col gap-1 rounded-card border-(length:--edge) border-line bg-card px-3 py-2 text-detail leading-snug">
              <span className="whitespace-pre-wrap">{asked.brief}</span>
              {asked.expected !== null && <span className="text-label">{copy.expected({ text: asked.expected })}</span>}
            </div>
          </Section>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

const lineKey = (line: HappenedLine): string => {
  switch (line.kind) {
    case "step":
    case "member":
      return line.task.id;
    case "checkpoint":
      return line.checkpoint.id;
    case "milestone":
      return line.milestone.id;
    case "refused":
      return `refused-${line.refusal.id}`;
    case "ended":
      return `ended-${line.attempt.id}`;
  }
};

/** One line of What happened, with its mark in words; a step or a member's Task opens its own Workbench. */
function Happened({ line, hobs, onOpen }: { line: HappenedLine; hobs: HobLookup; onOpen: (taskId: TaskId) => void }) {
  const mark = (
    <span
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center rounded-tag text-meta font-bold",
        GLYPH_TONE[line.mark],
      )}
    >
      <span aria-hidden>{GLYPH[line.mark]}</span>
      <span className="sr-only">{copy.mark[line.mark]}</span>
    </span>
  );
  const row = "flex items-start gap-2.5 px-2.5 py-1.5 text-detail leading-snug";
  if (line.kind === "step" || line.kind === "member") {
    const title = taskTitle(line.task);
    const text =
      line.kind === "step"
        ? copy.step({ index: line.index, total: line.total, title })
        : copy.member({ name: hobs(line.task.ownerId).name, title });
    return (
      <button
        type="button"
        onClick={() => onOpen(line.task.id)}
        aria-label={copy.lineLabel({ line: text, mark: copy.mark[line.mark], title })}
        className={cn(
          row,
          "w-full cursor-pointer rounded-control border-0 bg-transparent text-start text-text-strong hover:bg-hover",
        )}
      >
        {mark}
        <span className="min-w-0 flex-1">{text}</span>
        {line.tries > 1 && <span className="shrink-0 text-meta text-label">{copy.tries({ count: line.tries })}</span>}
      </button>
    );
  }
  if (line.kind === "refused") return <Refused line={line} hobs={hobs} mark={mark} row={row} />;
  return (
    <div className={row}>
      {mark}
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {line.kind === "checkpoint"
          ? line.checkpoint.summary
          : line.kind === "milestone"
            ? copy.milestone({ title: line.milestone.title })
            : line.mark === "failed"
              ? copy.endedFailed
              : line.mark === "unresolved"
                ? copy.endedUnresolved
                : copy.endedStopped}
        {line.kind === "ended" && line.attempt.outcome !== null && (
          <span className="block text-text-secondary">{copy.endedWhy({ why: line.attempt.outcome })}</span>
        )}
      </span>
    </div>
  );
}

/** A Task tool call the hub refused: the step it was, what the hob was told, and how many times it tried. */
function Refused({
  line,
  hobs,
  mark,
  row,
}: {
  line: Extract<HappenedLine, { kind: "refused" }>;
  hobs: HobLookup;
  mark: ReactNode;
  row: string;
}) {
  const { refusal } = line;
  const label = TASK_TOOLS.find((tool) => tool.name === refusal.tool)?.label ?? refusal.tool;
  return (
    <div data-slot="refused-call" className={row}>
      {mark}
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {copy.refused({ label })}
        <span className="block text-text-secondary">
          {copy.refusedTold({ name: hobs(refusal.agentId).name, message: refusal.message })}
        </span>
      </span>
      {refusal.tries > 1 && (
        <span className="shrink-0 text-meta text-label">{copy.tries({ count: refusal.tries })}</span>
      )}
    </div>
  );
}

/** The Task's Artifact references and the Attempt's changed files, each linked into Files or Changes. */
function Made({
  summary,
  owner,
  running,
  reading,
  onTab,
}: {
  summary: Summary;
  owner: string;
  running: boolean;
  reading: boolean;
  onTab: (tab: WorkbenchTab, focus?: string) => void;
}) {
  const { artifacts, changes } = summary.made;
  if (artifacts.length === 0 && changes.length === 0) {
    if (reading) return <Empty>{copy.readingChanges}</Empty>;
    return <Empty>{running ? copy.madeSoFar({ name: owner }) : copy.nothingMade({ name: owner })}</Empty>;
  }
  const shown = changes.slice(0, CHANGES_SHOWN);
  return (
    <div className="flex flex-col gap-2">
      {artifacts.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <Artifact artifact={artifact} onTab={onTab} />
            </li>
          ))}
        </ul>
      )}
      {changes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map(({ change, path }) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => onTab("changes", path)}
                aria-label={copy.seeChange({ path: change.path })}
                className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2.5 py-1 text-start text-detail text-text-strong hover:bg-hover"
              >
                <span className="w-16 shrink-0 text-meta font-bold text-label">{copy.change[change.kind]}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                {change.movedFrom !== null && (
                  <span className="min-w-0 truncate text-meta text-label">
                    {copy.movedFrom({ path: change.movedFrom })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {changes.length > shown.length && (
        <Button variant="text" size="xs" className="self-start" onClick={() => onTab("changes")}>
          {copy.moreChanges({ count: changes.length - shown.length })}
        </Button>
      )}
    </div>
  );
}

function Artifact({ artifact, onTab }: { artifact: ArtifactRef; onTab: (tab: WorkbenchTab, focus?: string) => void }) {
  const box = "flex flex-col gap-0.5 border-2 border-line bg-card px-3 py-2 text-detail";
  if (artifact.kind === "file") {
    return (
      <button
        type="button"
        onClick={() => onTab("files", artifact.value)}
        aria-label={copy.seeFile({ label: artifact.label })}
        className={cn(box, "w-full cursor-pointer text-start text-text-strong hover:bg-hover")}
      >
        <span className="font-bold">{artifact.label}</span>
        <span className="font-mono break-all text-text-secondary">{artifact.value}</span>
      </button>
    );
  }
  return (
    <div className={box}>
      <span className="font-bold">{artifact.label}</span>
      {artifact.kind === "link" ? (
        <a href={artifact.value} target="_blank" rel="noreferrer" className="break-all text-link">
          {artifact.value}
        </a>
      ) : (
        <span className="whitespace-pre-wrap">{artifact.value}</span>
      )}
    </div>
  );
}

/**
 * What is still open: questions and approvals, which you act on in the chat, and what the hobs on
 * this Task are waiting on, with Retry and Dismiss on a stuck item as on its blocker card.
 */
/** What Still open reads besides the Task's tree: the thread's approvals and every hob's backpack. */
const useOpenReads = (threadId: ThreadId | null) => {
  const approvals = useQuery({ ...approvalsQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== null });
  const backpack = useBackpack();
  const blockers = useBlockersQuery();
  // A Task outside any thread has no approvals to read.
  const approvalStatus = threadId === null ? "success" : approvals.status;
  return {
    approvals: approvals.data ?? [],
    items: backpack.items,
    blockers: blockers.data ?? [],
    // Nothing is said to be open, or not, until every read it rests on has answered (STD-UI-008).
    status: bothRead(bothRead(approvalStatus, backpack.status), blockers.status),
    retry: () => {
      if (approvals.isError) void approvals.refetch();
      if (backpack.status === "error") backpack.retry();
      if (blockers.isError) void blockers.refetch();
    },
  };
};

/**
 * Where you act on a question or an approval: the chat of the thread the Task's request came from,
 * which may not be the one the Workbench opened over when its Quest is pinned from another thread.
 * Going back to the same thread keeps its place and unsent message; an approval scrolls to its reply.
 */
const useTaskChat = (tree: WorkbenchTabProps["tree"], hobId: AgentId, threadId: ThreadId) => {
  const moves = useWorkbenchMoves(hobId, threadId);
  const navigate = useNavigate();
  const top = tree.tasks[0];
  return (messageId?: string | null) => {
    if (top === undefined || top.threadId === null || (top.threadId === threadId && top.ownerId === hobId)) {
      moves.back();
      return;
    }
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId: top.ownerId, threadId: top.threadId },
      search: messageId == null ? {} : { message: messageId },
    });
  };
};

/**
 * What is still open: questions and approvals, which you act on in the chat, and what the hobs on
 * this Task are waiting on, with Retry and Dismiss on a stuck item as on its blocker card. It says
 * nothing is open only once every read has answered, and says when one failed.
 */
function StillOpen({
  summary,
  tree,
  task,
  hobs,
  reads,
  onChat,
  onTask,
}: {
  summary: Summary;
  tree: WorkbenchTabProps["tree"];
  task: WorkbenchTabProps["task"];
  hobs: HobLookup;
  reads: ReturnType<typeof useOpenReads>;
  onChat: (messageId?: string | null) => void;
  onTask: (taskId: TaskId) => void;
}) {
  const now = useNow();
  const waiting = waitingView(reads.items, reads.blockers, subtreeScope(tree, task), now);
  const { questions, approvals, uncommitted } = summary.open;
  const none =
    questions.length === 0 && approvals.length === 0 && uncommitted.length === 0 && waiting.open.length === 0;
  if (none && reads.status === "success") return <Empty>{copy.nothingOpen}</Empty>;
  return (
    <div className="flex flex-col gap-1.5">
      {(questions.length > 0 || approvals.length > 0 || uncommitted.length > 0) && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {questions.map((question) => (
            <li key={question.id}>
              <OpenRow
                label={
                  question.recipientId === null
                    ? copy.questionForYou
                    : copy.questionFor({ name: hobs(question.recipientId).name })
                }
                text={question.text}
                action={question.recipientId === null ? copy.answerInChat : null}
                onAction={() => onChat()}
              />
            </li>
          ))}
          {approvals.map((approval) => (
            <li key={approval.id}>
              <OpenRow
                label={copy.approval}
                text={approval.label}
                action={copy.decideInChat}
                onAction={() => onChat(approval.messageId)}
              />
            </li>
          ))}
          {uncommitted.map((checkpoint) => (
            <li key={checkpoint.id}>
              <OpenRow label={copy.uncommitted} text={checkpoint.summary} action={null} onAction={() => {}} />
            </li>
          ))}
        </ul>
      )}
      {waiting.open.length > 0 && (
        <WaitingList
          view={{ ...waiting, handled: [], routine: 0 }}
          hobs={hobs}
          now={now}
          owners
          onOpen={(item) => item.taskId !== null && onTask(item.taskId)}
          label={copy.waitingList}
        />
      )}
      {reads.status === "pending" && <Empty>{copy.readingOpen}</Empty>}
      {reads.status === "error" && (
        <p role="alert" className="m-0 flex items-center gap-2 text-detail text-rose">
          <span className="flex-1">{copy.openUnread}</span>
          <Button variant="chip" size="xs" onClick={reads.retry}>
            {copy.tryAgain}
          </Button>
        </p>
      )}
    </div>
  );
}

function OpenRow({
  label,
  text,
  action,
  onAction,
}: {
  label: string;
  text: string;
  action: string | null;
  onAction: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5 border-2 border-line bg-card px-3 py-2 text-detail leading-snug">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-meta font-bold text-lantern">{label}</span>
        <span className="whitespace-pre-wrap">{text}</span>
      </span>
      {action !== null && (
        <Button variant="chip" size="xs" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  );
}

/** Buttons to the tabs the Task used, naming what each holds. */
function TabButtons({ used, onTab }: { used: Summary["used"]; onTab: (tab: WorkbenchTab) => void }) {
  if (used.changes + used.files + used.commands === 0) return null;
  return (
    <nav aria-label={copy.tabs} className="flex flex-wrap gap-2">
      {used.changes > 0 && (
        <Button variant="outline" size="sm" onClick={() => onTab("changes")}>
          {copy.seeChanges({ count: used.changes })}
        </Button>
      )}
      {used.files > 0 && (
        <Button variant="outline" size="sm" onClick={() => onTab("files")}>
          {copy.seeFiles({ count: used.files })}
        </Button>
      )}
      {used.commands > 0 && (
        <Button variant="outline" size="sm" onClick={() => onTab("terminal")}>
          {copy.seeTerminal}
        </Button>
      )}
    </nav>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="lbl m-0 text-meta text-label">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-detail text-text-secondary">{children}</p>;
}
