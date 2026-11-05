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

/** A save the stream or Undo reported, in its thread's list once that list is loaded. */
export const applyMemorySave = (queryClient: QueryClient, save: MemorySave) => {
  if (save.threadId === null) return;
  queryClient.setQueryData<ReadonlyArray<MemorySave>>(memorySaveKeys.thread(save.threadId), (old) => {
    if (old === undefined) return old;
    const known = old.find((stored) => stored.id === save.id);
    if (known === undefined) return [...old, save];
    const kept = later(known, save);
    return kept === known ? old : old.map((stored) => (stored.id === save.id ? kept : stored));
  });
};

/** Reads every thread's saves again, as when the stream resumes: it never streams a missed save again. */
export const refreshMemorySaves = (queryClient: QueryClient) => queryClient.invalidateQueries({ queryKey: savesKey });

/**
 * Undo for a save: the hub puts back the version it replaced, or removes the page it made. The line
 * says so at once; memory's own lists read again.
 */
export const useUndoMemorySave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (save: MemorySave) => call((c) => c.hobMemory.undoSave({ params: { saveId: save.id } })),
    onSuccess: async (undone) => {
      applyMemorySave(queryClient, undone);
      await refreshMemory(queryClient);
    },
  });
};
