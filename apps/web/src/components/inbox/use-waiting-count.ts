import type { AgentId, ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useWaitingQuestions } from "../../api/questions.ts";
import { pendingCount } from "./inbox-items.ts";

/**
 * How many things wait for the user, kept live by the journal: pending requests, questions no lead
 * could answer (ADR 018) and stuck work (IN-007). 0 until the Inbox is read.
 */
export const useWaitingCount = (): number =>
  (useQuery({ ...inboxQuery, select: pendingCount }).data ?? 0) + useWaitingQuestions().length + useBlockers().length;

/**
 * The hobs with a request, a question or stuck work waiting for the user. A question lights the
 * lead whose chat it waits in: the last to pass it up, or the asker when nobody leads it.
 */
export const useWaitingHobs = (): ReadonlySet<AgentId> => {
  const asking = useQuery({ ...inboxQuery, select: waitingHobs }).data ?? NONE;
  const questions = useWaitingQuestions();
  const stuck = useBlockers();
  if (stuck.length === 0 && questions.length === 0) return asking;
  return new Set([
    ...asking,
    ...questions.map(({ question }) => question.chain.at(-1) ?? question.askerId),
    ...stuck.map((item) => item.recipientId),
  ]);
};
const NONE: ReadonlySet<AgentId> = new Set();

const waitingHobs = (approvals: ReadonlyArray<ApprovalRequest>): ReadonlySet<AgentId> =>
  new Set(approvals.flatMap((approval) => (approval.state === "pending" ? [approval.agentId] : [])));
