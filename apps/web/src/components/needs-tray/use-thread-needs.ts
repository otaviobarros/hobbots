import type { ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { approvalsQuery, inboxQuery } from "../../api/approvals.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useWaitingHobProposals } from "../../api/hob-proposals.ts";
import { useHubQuestions } from "../../api/hub-questions.ts";
import { useWaitingQuestions } from "../../api/questions.ts";
import { scopedTray, type TrayEntry, trayEntries } from "./tray-entries.ts";

const NONE = { here: [], everywhere: [] } as const satisfies Record<string, ReadonlyArray<TrayEntry>>;

/**
 * What waits on you, for a chat's or camp's tray: `here` holds what is about this chat or camp (its
 * pending requests, a party member's included, the hob proposals its Summoning calls made, the work its
 * requests started that is stuck, and the questions that reached you from it), and `everywhere` holds
 * the same from every chat and camp (#1423). The requests come from the Inbox's read, which holds
 * every pending one, and from the thread's own until that read is in.
 */
export const useThreadNeeds = (
  threadId: ThreadId | undefined,
): { readonly here: ReadonlyArray<TrayEntry>; readonly everywhere: ReadonlyArray<TrayEntry> } => {
  const thread = useQuery({ ...approvalsQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  const inbox = useQuery(inboxQuery);
  const blockers = useBlockers();
  const questions = useWaitingQuestions();
  const hubQuestions = useHubQuestions();
  const hobProposals = useWaitingHobProposals();
  if (threadId === undefined) return NONE;
  const requests = inbox.data ?? thread.data ?? [];
  return scopedTray(trayEntries({ requests, blockers, questions, hubQuestions, hobProposals }), threadId);
};
