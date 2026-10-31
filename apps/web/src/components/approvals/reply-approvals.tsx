import type { Agent, MessageId, ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { approvalsQuery } from "../../api/approvals.ts";
import { ApprovalCard } from "./approval-card.tsx";

/** The approval requests a reply's tool calls made, oldest first, each as its card. */
export function ReplyApprovals({ threadId, messageId, hob }: { threadId: ThreadId; messageId: MessageId; hob: Agent }) {
  const approvals = useQuery({
    ...approvalsQuery(threadId),
    select: (all) => all.filter((approval) => approval.messageId === messageId),
  });
  return approvals.data?.map((approval) => <ApprovalCard key={approval.id} approval={approval} hob={hob} />);
}
