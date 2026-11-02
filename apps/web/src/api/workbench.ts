import type { AttemptActivityRead } from "@hobbots/api";
import type { AttemptId, CommandId, CommandOutput, ContentId, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { API_URL, call } from "./client.ts";
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
  output: (attemptId: AttemptId) => ["workbench", "output", attemptId] as const,
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

/** Where the hub serves kept contents, for an image to load them itself. */
export const attemptContentUrl = (attemptId: AttemptId, contentId: ContentId): string =>
  `${API_URL}/api/attempts/${encodeURIComponent(attemptId)}/contents/${encodeURIComponent(contentId)}`;

/** Nothing on the hub to read a running command's output again from, so a resync leaves it. */
const LOCAL = { local: true } as const;

/**
 * What a running command printed so far, as it came. `missed` is set when a piece started past
 * what this client had, as after a reconnect: what came before it was not seen live, and the whole
 * output shows once the command ends.
 */
export interface LiveOutput {
  readonly text: string;
  /** Where `text` ends in what the command printed so far, in UTF-16 code units; past its length after a gap. */
  readonly end: number;
  readonly missed: boolean;
}

/** The output of each of an Attempt's commands still running, by command. */
export type LiveOutputs = Readonly<Record<CommandId, LiveOutput>>;

/**
 * Adds a piece of a running command's output by its offset in all the command printed, so a repeated
 * piece changes nothing. A piece past the end of what is known starts the text again from it and
 * marks the gap; later pieces follow on from where it ended.
 */
export const addOutput = (outputs: LiveOutputs, event: CommandOutput): LiveOutputs => {
  const known = outputs[event.commandId] ?? { text: "", end: 0, missed: false };
  if (event.offset > known.end) {
    const restarted = { text: event.delta, end: event.offset + event.delta.length, missed: true };
    return { ...outputs, [event.commandId]: restarted };
  }
  const fresh = event.delta.slice(known.end - event.offset);
  if (fresh.length === 0) return outputs;
  const grown = { ...known, text: known.text + fresh, end: known.end + fresh.length };
  return { ...outputs, [event.commandId]: grown };
};

/**
 * The output an Attempt's running commands printed, learned from the event stream only: it is
 * transient, so nothing reads it from the hub. A command's record carries its whole output once
 * it ends.
 */
export const liveOutputQuery = (attemptId: AttemptId) =>
  queryOptions({
    queryKey: workbenchKeys.output(attemptId),
    queryFn: (): LiveOutputs => ({}),
    staleTime: Number.POSITIVE_INFINITY,
    meta: LOCAL,
  });

/** Applies a piece of a running command's output to its Attempt's live output. */
export const applyCommandOutput = (queryClient: QueryClient, event: CommandOutput) => {
  // Built with its options first, so a resync knows to leave it even before the Terminal reads it.
  const queryKey = workbenchKeys.output(event.attemptId);
  queryClient.getQueryCache().build(queryClient, { queryKey, meta: LOCAL });
  queryClient.setQueryData<LiveOutputs>(queryKey, (old = {}) => addOutput(old, event));
};
