import type { TreeActivityRead } from "@hobbots/api";
import type { AttemptId, CommandId, CommandOutput, ContentId, TaskFileId, TaskId } from "@hobbots/domain";
import { keepPreviousData, type QueryClient, queryOptions } from "@tanstack/react-query";
import { API_URL, call } from "./client.ts";
import { syncState } from "./sync.ts";

/**
 * What a Quest's Attempts ran, changed and made, as its one Workbench reads it (ADR 023, ADR 027): the
 * whole tree in one read, kept live by the tree's own stream (`useWorkbenchStream`). A recorded
 * command, file change or scan, and a Task or Attempt that changes, read the tree again; a running
 * command's output, which is transient, is kept apart for the Terminal.
 */
const workbenchKeys = {
  tree: (taskId: TaskId) => ["workbench", "tree", taskId] as const,
  content: (attemptId: AttemptId, contentId: ContentId) => ["workbench", "content", attemptId, contentId] as const,
  output: (attemptId: AttemptId) => ["workbench", "output", attemptId] as const,
};

/**
 * Reads a Task tree's Workbench for the current sync generation. A read that lands after a new
 * generation began may predate records the stream can no longer replay, so it is read again; a new
 * generation only invalidates, and with no data yet TanStack Query hands back the read on its way.
 */
const readTree = async (client: QueryClient, taskId: TaskId): Promise<TreeActivityRead> => {
  for (;;) {
    const generation = syncState(client).generation;
    const read = await call((c) => c.workbench.tree({ params: { taskId } }));
    if (syncState(client).generation === generation) return read;
  }
};

/**
 * Every Attempt under a Task with its records and files, and the stream cursor taken just before the
 * read. The files are as they are now, so coming back to the app reads them again.
 */
export const workbenchTreeQuery = (taskId: TaskId) =>
  queryOptions({
    queryKey: workbenchKeys.tree(taskId),
    queryFn: ({ client }) => readTree(client, taskId),
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

/**
 * Reads a tree's Workbench again once the hub recorded a change to it. A read already on its way may
 * have been taken before the change, so it is cancelled first (STD-REACT-012).
 */
export const treeChanged = async (queryClient: QueryClient, taskId: TaskId) => {
  const queryKey = workbenchKeys.tree(taskId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true });
};

/** Where the hub serves one of an Attempt's files: a preview, or the file itself as a download. */
export const taskFileUrl = (
  attemptId: AttemptId,
  fileId: TaskFileId,
  { download = false, version = null }: { download?: boolean; version?: string | null } = {},
): string => {
  const query = new URLSearchParams();
  if (download) query.set("download", "1");
  // What the file holds now, so a preview loads again when the file changes under the same id.
  if (version !== null) query.set("v", version);
  const search = query.size === 0 ? "" : `?${query.toString()}`;
  return `${API_URL}/api/attempts/${encodeURIComponent(attemptId)}/files/${encodeURIComponent(fileId)}${search}`;
};

/** A text file's preview, as the hub serves it: redacted and cut to its first MiB. */
export const taskFileTextQuery = (attemptId: AttemptId, fileId: TaskFileId, version: string | null) =>
  queryOptions({
    queryKey: ["workbench", "file-text", attemptId, fileId, version] as const,
    queryFn: async ({ signal }) => {
      const response = await fetch(taskFileUrl(attemptId, fileId, { version }), { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(`The hub answered ${response.status}`);
      return response.text();
    },
  });

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
