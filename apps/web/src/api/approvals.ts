import type { ApprovalDecision, ApprovalLifetime, ApprovalRequest, GrantRule, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { inboxWindow } from "./inbox-window.ts";
import { newer, recordApproval, syncedApprovals, syncedInbox } from "./sync.ts";

export const approvalsKey = (threadId: ThreadId) => ["threads", threadId, "approvals"] as const;

/** The thread's approval requests, oldest first, whatever their state (PE-003). */
export const approvalsQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: approvalsKey(threadId),
    queryFn: syncedApprovals(threadId, () => call((c) => c.approvals.forThread({ params: { threadId } }))),
  });

/** Keeps the newer version of a request in its thread's list, adding it when it is new. */
export const storeApproval = (queryClient: QueryClient, approval: ApprovalRequest) => {
  recordApproval(queryClient, approval);
  queryClient.setQueryData<ReadonlyArray<ApprovalRequest>>(approvalsKey(approval.threadId), (old) =>
    withApproval(old, approval),
  );
  queryClient.setQueryData<ReadonlyArray<ApprovalRequest>>(inboxKey, (old) => {
    const updated = withApproval(old, approval);
    return updated === old || updated === undefined ? updated : inboxWindow(updated);
  });
};

export interface Decision {
  readonly decision: ApprovalDecision;
  readonly reason?: string | undefined;
  /** The user's confirmation of a high-risk action, which approving it needs. */
  readonly confirmed?: boolean | undefined;
  /** How long an approval lasts; once when absent. */
  readonly lifetime?: ApprovalLifetime | undefined;
  /** The rules This Quest or Always saves, as the card showed them; the request's own when absent. */
  readonly rules?: ReadonlyArray<GrantRule> | undefined;
}

/**
 * Decides one request as the user saw it: the action digest shown goes with the decision, so it
 * never applies to another action. A refused decision refetches the thread's requests, since the
 * request was most likely decided elsewhere or has expired; the Inbox is refetched too.
 */
export const useDecideApproval = (approval: ApprovalRequest) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, reason, confirmed, lifetime, rules }: Decision) =>
      call((c) =>
        c.approvals.decide({
          params: { approvalId: approval.id },
          payload: {
            decision,
            actionDigest: approval.actionDigest,
            ...(reason !== undefined && reason.trim() !== "" && { reason: reason.trim() }),
            ...(confirmed === true && { confirmed }),
            ...(lifetime !== undefined && { lifetime }),
            ...(rules !== undefined && { rules }),
          },
        }),
      ),
    onSuccess: (decided) => storeApproval(queryClient, decided),
    onError: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: approvalsKey(approval.threadId), exact: true }),
        queryClient.invalidateQueries({ queryKey: inboxKey, exact: true }),
      ]),
  });
};

/** The Inbox's requests from every thread: every pending one and the most recent closed ones, oldest first. */
const inboxKey = ["approvals"] as const;

export const inboxQuery = queryOptions({
  queryKey: inboxKey,
  queryFn: syncedInbox(() => call((c) => c.approvals.list())),
});

/** A cached list with the newer version of the request, added when it is new. */
const withApproval = (old: ReadonlyArray<ApprovalRequest> | undefined, approval: ApprovalRequest) => {
  if (old === undefined) return old;
  const known = old.find((existing) => existing.id === approval.id);
  if (known === undefined) return [...old, approval];
  const kept = newer(known, approval);
  return kept === known ? old : old.map((existing) => (existing === known ? kept : existing));
};
