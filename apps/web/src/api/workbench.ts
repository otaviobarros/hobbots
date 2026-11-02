import type { AttemptId, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/**
 * What an Attempt ran, changed and made, as the Workbench reads it (ADR 023). A recorded command,
 * file change or scan reads the Attempt's records again; a running command's output, which is
 * transient, is left to the Terminal.
 */
const workbenchKeys = {
  all: ["workbench"] as const,
  activity: (attemptId: AttemptId) => ["workbench", "activity", attemptId] as const,
};

export const attemptActivityQuery = (attemptId: AttemptId) =>
  queryOptions({
    queryKey: workbenchKeys.activity(attemptId),
    queryFn: () => call((c) => c.workbench.activity({ params: { attemptId } })),
    select: (read) => read.activity,
  });

/** The Attempt a journaled Workbench event records for, or null for any other event. */
export const recordedAttempt = (event: HobbotsEvent): AttemptId | null => {
  switch (event._tag) {
    case "CommandRecorded":
      return event.command.attemptId;
    case "FileChangesRecorded":
      return event.attemptId;
    case "FolderScanned":
      return event.scan.attemptId;
    default:
      return null;
  }
};

/**
 * Reads an Attempt's records again once the hub recorded more of them. A read already on its way
 * may have been taken before the change, so it is cancelled first (STD-REACT-012).
 */
export const activityChanged = async (queryClient: QueryClient, attemptId: AttemptId) => {
  const queryKey = workbenchKeys.activity(attemptId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true });
};
