import type { Agent, ApprovalRequest, MessageId, ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { approvalsQuery } from "../../api/approvals.ts";
import { messages } from "../messages.ts";
import { resultText } from "./approval-text.ts";

const copy = messages.approval;

/**
 * How each request a reply's tool calls made was decided, one plain line each, oldest first. A
 * request still waiting shows in the Needs-you tray above the composer instead.
 */
export function ReplyApprovals({ threadId, messageId, hob }: { threadId: ThreadId; messageId: MessageId; hob: Agent }) {
  const approvals = useQuery({
    ...approvalsQuery(threadId),
    select: (all) => all.filter((approval) => approval.messageId === messageId),
  });
  // The requests this page saw waiting, so the line of one decided here can take the focus the tray had.
  const seenPending = useRef(new Set<string>());
  for (const approval of approvals.data ?? []) {
    if (approval.state === "pending") seenPending.current.add(approval.id);
  }
  return approvals.data?.map((approval) =>
    approval.state === "pending" ? null : (
      <DecidedLine
        key={approval.id}
        approval={approval}
        name={hob.name}
        justDecided={seenPending.current.has(approval.id)}
      />
    ),
  );
}

/**
 * One decided request in the transcript. When it was decided while this page showed it and focus
 * fell back to the page with the tray's buttons, focus moves here, so the outcome is read out.
 */
function DecidedLine({
  approval,
  name,
  justDecided,
}: {
  approval: ApprovalRequest;
  name: string;
  justDecided: boolean;
}) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    if (justDecided && focusLost) line.current?.focus();
  }, [justDecided]);
  return (
    <section aria-label={copy.asks({ name })} data-state={approval.state}>
      <p ref={line} role="status" tabIndex={-1} className="m-0 animate-hb-in text-detail text-text-secondary">
        {resultText(approval, name)}
      </p>
    </section>
  );
}
