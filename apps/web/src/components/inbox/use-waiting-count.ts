import type { AgentId, ApprovalRequest, ThreadId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useFailedTasks } from "../../api/failed-tasks.ts";
import { useWaitingHobProposals } from "../../api/hob-proposals.ts";
import { useHubQuestions } from "../../api/hub-questions.ts";
import { useWaitingShares } from "../../api/memory-shares.ts";
import { usePromptedDevices } from "../../api/pairing.ts";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { useWaitingQuestions } from "../../api/questions.ts";
import { useWaitingProposals } from "../../api/skill-proposals.ts";
import { type HobNeed, hobNeeds, leadNeeds } from "../../lib/hob-state.ts";
import { pendingCount } from "./inbox-items.ts";

/**
 * How many things wait for the user, kept live by the journal: pending requests, questions no lead
 * could answer (ADR 018), questions the hub itself asks (#976), stuck work (IN-007), party members'
 * failed Tasks (ADR 027), devices asking to pair (ADR 021), hobs asking to share what they
 * learned (ADR 028), skills hobs drafted (ADR 029) and what managers propose for hobs (ADR 034).
 * 0 until the Inbox is read.
 */
export const useWaitingCount = (): number =>
  (useQuery({ ...inboxQuery, select: pendingCount }).data ?? 0) +
  useWaitingQuestions().length +
  useHubQuestions().length +
  useBlockers().length +
  useFailedTasks().length +
  usePromptedDevices().length +
  useWaitingShares().length +
  useWaitingProposals().length +
  useWaitingHobProposals().length;

/**
 * The hobs with a request, a question or stuck work waiting for the user, and what each waits for.
 * A question marks the hob that asked and the lead whose chat it waits in.
 */
export const useWaitingHobs = (): ReadonlyMap<AgentId, HobNeed> =>
  hobNeeds({
    approvals: useQuery(inboxQuery).data ?? NONE,
    blockers: useBlockers(),
    questions: useWaitingQuestions(),
  });
const NONE: ReadonlyArray<ApprovalRequest> = [];

/**
 * The hobs the sidebar marks as needing you (ADR 027): the lead whose chat each request, question,
 * stuck work or member's failed Task waits in, since you talk only to the lead.
 */
export const useLeadsNeedingYou = (): ReadonlySet<AgentId> => {
  const hobs = useQuery(agentsQuery).data ?? [];
  const owners = useQueries({
    queries: hobs.map((hob) => threadsQuery(hob.id)),
    combine: (results) =>
      new Map(results.flatMap((result) => (result.data ?? []).map((thread) => [thread.id, thread.agentId] as const))),
  });
  return leadNeeds({
    approvals: useQuery(inboxQuery).data ?? NONE,
    blockers: useBlockers(),
    questions: useWaitingQuestions(),
    failed: useFailedTasks(),
    leadOf: (threadId: ThreadId) => owners.get(threadId),
  });
};
