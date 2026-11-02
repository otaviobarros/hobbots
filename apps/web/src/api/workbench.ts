import type { AttemptActivityRead } from "@hobbots/api";
import type { AttemptId, ContentId, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";
import { syncState } from "./sync.ts";

/**
 * What an Attempt ran, changed and made, as the Workbench reads it (ADR 023). A recorded command,
 * file change or scan reads the Attempt's records again; a running command's output, which is
 * transient, is left to the Terminal.
 */
const workbenchKeys = {
  all: ["workbench"] as const,
  activity: (attemptId: AttemptId) => ["workbench", "activity", attemptId] as const,
  content: (attemptId: AttemptId, contentId: ContentId) => ["workbench", "content", attemptId, contentId] as const,
};

/**
 * Reads an Attempt's records for the current sync generation. A read that lands after a new
 * generation began may predate records the stream can no longer replay, so it is read again; a new
 * generation only invalidates, and with no data yet TanStack Query hands back the read on its way.
 */
const readActivity = async (client: QueryClient, attemptId: AttemptId): Promise<AttemptActivityRead> => {
  for (;;) {
    const generation = syncState(client).generation;
    const read = await call((c) => c.workbench.activity({ params: { attemptId } }));
    if (syncState(client).generation === generation) return read;
  }
};

export const attemptActivityQuery = (attemptId: AttemptId) =>
  queryOptions({
    queryKey: workbenchKeys.activity(attemptId),
    queryFn: ({ client }) => readActivity(client, attemptId),
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

/**
 * Kept contents a file change of an Attempt names: text redacted, images as they were. Contents are
 * kept once per hash, so what an id names never changes and is never read again; a read that fails
 * because the contents were cleared says so through its error.
 */
export const attemptContentQuery = (attemptId: AttemptId, contentId: ContentId) =>
  queryOptions({
    queryKey: workbenchKeys.content(attemptId, contentId),
    queryFn: () => call((c) => c.workbench.content({ params: { attemptId, contentId } })),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
