import type { AgentId, Task, TaskId, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { approvalsQuery } from "../../../api/approvals.ts";
import { useBackpack } from "../../../api/backpack.ts";
import { useBlockersQuery } from "../../../api/blockers.ts";
import { bothRead, waitingView } from "../../backpack/backpack-model.ts";
import { WaitingList } from "../../backpack/waiting-list.tsx";
import { useNow } from "../../inbox/use-now.ts";
import { HubWait, ROW_WIDTHS, SKELETON_ROWS } from "../../loading/hub-wait.tsx";
import type { HobLookup } from "../../quest/use-work.ts";
import { messages } from "../messages.ts";
import { Empty } from "./summary-made.tsx";
import { type Summary, subtreeScope } from "./summary-model.ts";

const copy = messages.summary;

/** What Still open reads besides the Task's tree: the thread's approvals and every hob's backpack. */
export const useOpenReads = (threadId: ThreadId | null) => {
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
 * which may not be the one beside the room when its Quest is pinned from another thread. The chat
 * beside the room keeps its place and unsent message, and an approval scrolls to its reply there.
 */
export const useTaskChat = (tree: TaskTree, hobId: AgentId, threadId: ThreadId) => {
  const navigate = useNavigate();
  const top = tree.tasks[0];
  return (messageId?: string | null) => {
    if (top === undefined || top.threadId === null || (top.threadId === threadId && top.ownerId === hobId)) {
      if (messageId == null) return;
      void navigate({
        from: "/hobs/$hobId/threads/$threadId",
        to: "/hobs/$hobId/threads/$threadId",
        params: { hobId, threadId },
        search: (prev) => ({ ...prev, message: messageId }),
        replace: true,
      });
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
export function StillOpen({
  summary,
  tree,
  task,
  hobs,
  reads,
  onChat,
  onTask,
}: {
  summary: Summary;
  tree: TaskTree;
  task: Task;
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
      {reads.status === "pending" && none && <OpenSkeleton onRetry={reads.retry} />}
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
    <div className="flex items-start gap-2.5 border-(length:--edge) border-line bg-card px-3 py-2 text-detail leading-snug">
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

/** Three open rows while what is still open is read: a label and a line, on the rows' card. */
function OpenSkeleton({ onRetry }: { onRetry: () => void }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-1.5">
      <ul aria-hidden className="m-0 flex list-none flex-col gap-1 p-0">
        {SKELETON_ROWS.map((row) => (
          <li
            key={row}
            className="flex flex-col gap-0.5 border-(length:--edge) border-line bg-card px-3 py-2 text-detail leading-snug"
          >
            <span className="text-meta">
              <Skeleton surface="card" width="12ch" />
            </span>
            <Skeleton surface="card" width={ROW_WIDTHS[row]} className="max-w-full" />
          </li>
        ))}
      </ul>
      <HubWait pending onRetry={onRetry} />
    </div>
  );
}
