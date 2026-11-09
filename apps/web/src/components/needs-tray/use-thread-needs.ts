import type { ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { approvalsQuery } from "../../api/approvals.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useWaitingHobProposals } from "../../api/hob-proposals.ts";
import { useHubQuestions } from "../../api/hub-questions.ts";
import { useWaitingQuestions } from "../../api/questions.ts";
import { type TrayEntry, trayEntries } from "./tray-entries.ts";

const NONE: ReadonlyArray<TrayEntry> = [];

/**
 * What waits on you in one chat, for its tray: the thread's pending requests, a party member's
 * included, the hob proposals its Summoning calls made, the work its requests started that is stuck, and the questions that reached you from it.
 */
export const useThreadNeeds = (threadId: ThreadId | undefined): ReadonlyArray<TrayEntry> => {
  const requests = useQuery({ ...approvalsQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  const blockers = useBlockers();
  const questions = useWaitingQuestions();
  const hubQuestions = useHubQuestions();
  const hobProposals = useWaitingHobProposals();
  if (threadId === undefined) return NONE;
  return trayEntries({ requests: requests.data ?? [], blockers, questions, hubQuestions, hobProposals, threadId });
};
