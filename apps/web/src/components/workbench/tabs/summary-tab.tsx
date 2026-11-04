import { AgentId, type ArtifactRef, isLiveAttempt, TASK_TOOLS, type TaskId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { approvalsQuery } from "../../../api/approvals.ts";
import { useBackpack } from "../../../api/backpack.ts";
import { useBlockersQuery } from "../../../api/blockers.ts";
import { bothRead, waitingView } from "../../backpack/backpack-model.ts";
import { WaitingList } from "../../backpack/waiting-list.tsx";
import { useNow } from "../../inbox/use-now.ts";
import { StatusTag } from "../../quest/status-dot.tsx";
import { type HobLookup, useOpenTask } from "../../quest/use-work.ts";
import type { RowStatus } from "../../quest/work-model.ts";
import { taskTitle } from "../../quest/work-model.ts";
import { messages } from "../messages.ts";
import { useOpenWorkbench, useWorkbenchMoves } from "../use-workbench.ts";
import type { WorkbenchTab } from "../workbench-model.ts";
import { type HappenedLine, type Mark, type Summary, subtreeScope, summaryOf } from "./summary-model.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const copy = messages.summary;

/** Changed files listed before the rest fold into one link to Changes. */
const CHANGES_SHOWN = 6;

const TONE: Readonly<Record<Mark, RowStatus>> = {
  done: "done",
  failed: "failed",
  waiting: "waiting",
  running: "running",
  next: "waiting",
  cancelled: "waiting",
  unresolved: "blocked",
};

/**
 * The Summary tab (ADR 023): what the hob was asked, what happened, what it made, what is still
 * open and its result, in plain words, built from the hub's records with no model call. Each line
 * links to the tab or the chat that holds its detail, and buttons at the end name the tabs the Task used.
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
    <div data-slot="summary" className="flex max-w-3xl flex-col gap-5 px-5 py-4">
      <Section title={summary.asked.from === null ? copy.asked : copy.askedBy({ name: hobs(summary.asked.from).name })}>
        <div className="flex flex-col gap-1 border-2 border-line bg-card px-3 py-2 text-detail leading-snug">
          <span className="whitespace-pre-wrap">{summary.asked.brief}</span>
          {summary.asked.expected !== null && (
            <span className="text-label">{copy.expected({ text: summary.asked.expected })}</span>
          )}
        </div>
      </Section>
      <Section title={copy.happened}>
        {summary.happened.length === 0 ? (
          <Empty>{running ? copy.nothingYet({ name: owner }) : copy.nothingHappened({ name: owner })}</Empty>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {summary.happened.map((line) => (
              <li key={lineKey(line)}>
                <Happened line={line} hobs={hobs} onOpen={(id) => openWorkbench(id)} />
              </li>
            ))}
          </ol>
        )}
      </Section>
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
      <Section title={copy.result}>
        <Result tree={tree} result={summary.result} attempt={attempt} />
      </Section>
      <TabButtons used={summary.used} onTab={onTab} />
    </div>
  );
}

/** The Task's result, saying which Attempt it came from when another one is shown. */
function Result({
  tree,
  result,
  attempt,
}: {
  tree: WorkbenchTabProps["tree"];
  result: Summary["result"];
  attempt: WorkbenchTabProps["attempt"];
}) {
  if (result === null) return <Empty>{copy.noResult}</Empty>;
  const from = tree.attempts.find((each) => each.id === result.attemptId);
  return (
    <div className="flex flex-col gap-1 text-detail leading-snug">
      <p className="m-0 whitespace-pre-wrap">{result.summary}</p>
      {attempt !== null && from !== undefined && from.id !== attempt.id && (
        <span className="text-xs text-label">{copy.resultFrom({ number: from.number })}</span>
      )}
    </div>
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
  const mark = <StatusTag status={TONE[line.mark]}>{copy.mark[line.mark]}</StatusTag>;
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
        className={cn(row, "w-full cursor-pointer border-0 bg-card text-start text-text-strong hover:bg-hover")}
      >
        {mark}
        <span className="min-w-0 flex-1">{text}</span>
        {line.tries > 1 && <span className="shrink-0 text-xs text-label">{copy.tries({ count: line.tries })}</span>}
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
      {refusal.tries > 1 && <span className="shrink-0 text-xs text-label">{copy.tries({ count: refusal.tries })}</span>}
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
                <span className="w-16 shrink-0 text-xs font-bold text-label">{copy.change[change.kind]}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                {change.movedFrom !== null && (
                  <span className="min-w-0 truncate text-xs text-label">
                    {copy.movedFrom({ path: change.movedFrom })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {changes.length > shown.length && (
        <Button variant="link" size="xs" className="self-start" onClick={() => onTab("changes")}>
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
        <a href={artifact.value} target="_blank" rel="noreferrer" className="break-all text-lantern">
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
        <span className="text-xs font-bold text-lantern">{label}</span>
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
    <nav aria-label={copy.tabs} className="flex flex-wrap gap-2 border-t-2 border-line pt-4">
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
      <h3 className="lbl m-0 text-xs text-label">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-detail text-text-secondary">{children}</p>;
}
