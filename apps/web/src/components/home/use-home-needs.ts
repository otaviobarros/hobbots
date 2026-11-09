import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockersQuery } from "../../api/blockers.ts";
import { hobProposalsQuery } from "../../api/hob-proposals.ts";
import { useHubQuestionsQuery } from "../../api/hub-questions.ts";
import { useWaitingQuestionsQuery } from "../../api/questions.ts";
import { type TrayEntry, trayEntries } from "../needs-tray/tray-entries.ts";

/**
 * What waits on you in every chat, for Home's tray: pending requests, hob proposals, stuck work and questions, the
 * hub's own included (#976), in
 * the tray's order. `ready` once every read is in, so the all-clear line never shows too early.
 */
export const useHomeNeeds = (): { readonly entries: ReadonlyArray<TrayEntry>; readonly ready: boolean } => {
  const requests = useQuery(inboxQuery);
  const blockers = useBlockersQuery();
  const questions = useWaitingQuestionsQuery();
  const hubQuestions = useHubQuestionsQuery();
  const hobProposals = useQuery(hobProposalsQuery);
  return {
    entries: trayEntries({
      requests: requests.data ?? [],
      blockers: blockers.data ?? [],
      questions: questions.data ?? [],
      hubQuestions: hubQuestions.data ?? [],
      hobProposals: hobProposals.data ?? [],
    }),
    ready:
      requests.isSuccess &&
      blockers.isSuccess &&
      questions.isSuccess &&
      hubQuestions.isSuccess &&
      hobProposals.isSuccess,
  };
};
