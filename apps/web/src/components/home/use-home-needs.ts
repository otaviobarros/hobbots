import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockersQuery } from "../../api/blockers.ts";
import { useWaitingQuestionsQuery } from "../../api/questions.ts";
import { type TrayEntry, trayEntries } from "../needs-tray/tray-entries.ts";

/**
 * What waits on you in every chat, for Home's tray: pending requests, stuck work and questions, in
 * the tray's order. `ready` once every read is in, so the all-clear line never shows too early.
 */
export const useHomeNeeds = (): { readonly entries: ReadonlyArray<TrayEntry>; readonly ready: boolean } => {
  const requests = useQuery(inboxQuery);
  const blockers = useBlockersQuery();
  const questions = useWaitingQuestionsQuery();
  return {
    entries: trayEntries({
      requests: requests.data ?? [],
      blockers: blockers.data ?? [],
      questions: questions.data ?? [],
    }),
    ready: requests.isSuccess && blockers.isSuccess && questions.isSuccess,
  };
};
