import type { AgentId, ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockers } from "../../api/blockers.ts";
import { usePromptedDevices } from "../../api/pairing.ts";
import { useWaitingQuestions } from "../../api/questions.ts";
import { type HobNeed, hobNeeds } from "../../lib/hob-state.ts";
import { pendingCount } from "./inbox-items.ts";

/**
 * How many things wait for the user, kept live by the journal: pending requests, questions no lead
 * could answer (ADR 018), stuck work (IN-007) and devices asking to pair (ADR 021). 0 until the
 * Inbox is read.
 */
export const useWaitingCount = (): number =>
  (useQuery({ ...inboxQuery, select: pendingCount }).data ?? 0) +
  useWaitingQuestions().length +
  useBlockers().length +
  usePromptedDevices().length;

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
