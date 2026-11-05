import type { AgentId, MemorySave, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { MEMORY_RETRY_MS, memoryKeys, refreshMemory } from "./memory-pages.ts";

/**
 * Memory in a chat and on a hob's page (ADR 028, #961): the saves a thread's replies made, Undo for
 * one of them, and what a hob reads.
 */

const savesKey = ["memory-saves"] as const;

const memorySaveKeys = {
  thread: (threadId: ThreadId) => [...savesKey, "thread", threadId] as const,
  // Under the Memory page's reads, so a save memory reports reads the counts again.
  hob: (agentId: AgentId) => [...memoryKeys.all, "hob", agentId] as const,
};

/** The saves the thread's replies made; the stream adds later ones and their outcomes. */
export const threadMemorySavesQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: memorySaveKeys.thread(threadId),
    queryFn: () => call((c) => c.hobMemory.threadSaves({ params: { threadId } })),
  });

/**
 * What the hob reads, with each scope's count: its own memory, About you, then its projects. Read
 * again every 30 seconds while memory does not answer, as the Memory page's reads are.
 */
export const hobMemoryScopesQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: memorySaveKeys.hob(agentId),
    queryFn: () => call((c) => c.hobMemory.hobScopes({ params: { agentId } })),
    refetchInterval: (query) => (query.state.status === "error" ? MEMORY_RETRY_MS : false),
  });

/** The later of two records of one save, by when it last changed; Undo is final. */
const later = (a: MemorySave, b: MemorySave) => (a.undoneAt === undefined && b.updatedAt >= a.updatedAt ? b : a);

/** `saves` with `save` in it: added, or kept in place of an older record of it. */
const withSave = (saves: ReadonlyArray<MemorySave> | undefined, save: MemorySave) => {
  if (saves === undefined) return saves;
  const known = saves.find((stored) => stored.id === save.id);
  if (known === undefined) return [...saves, save];
  const kept = later(known, save);
  return kept === known ? saves : saves.map((stored) => (stored.id === save.id ? kept : stored));
};

/**
 * A save the stream or Undo reported, in its thread's list (STD-REACT-012). A read still on its way
 * may predate the save, so it is cancelled and the list read again; a list not loaded yet has no read
 * of its own to take the save into, so it is read once the cancelled read is gone.
 */
export const applyMemorySave = async (queryClient: QueryClient, save: MemorySave): Promise<void> => {
  if (save.threadId === null) return;
  const queryKey = memorySaveKeys.thread(save.threadId);
  const take = () => queryClient.setQueryData<ReadonlyArray<MemorySave>>(queryKey, (old) => withSave(old, save));
  take();
  if (queryClient.isFetching({ queryKey, exact: true }) === 0) return;
  await queryClient.cancelQueries({ queryKey, exact: true });
  take();
  await queryClient.invalidateQueries({ queryKey, exact: true });
};

/**
 * Reads every thread's saves again, as when the stream resumes: it never streams a missed save again,
 * and a read already on its way may predate what was missed, so it is cancelled first.
 */
export const refreshMemorySaves = async (queryClient: QueryClient): Promise<void> => {
  await queryClient.cancelQueries({ queryKey: savesKey });
  await queryClient.invalidateQueries({ queryKey: savesKey });
};

/**
 * Undo for a save: the hub puts back the version it replaced, or removes the page it made. The line
 * says so at once; memory's own lists read again.
 */
export const useUndoMemorySave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (save: MemorySave) => call((c) => c.hobMemory.undoSave({ params: { saveId: save.id } })),
    onSuccess: async (undone) => {
      await Promise.all([applyMemorySave(queryClient, undone), refreshMemory(queryClient)]);
    },
  });
};
