import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  applyMemoryWrite,
  deleteMemoryPage,
  memoryNotAnswering,
  memoryPageChanged,
  refreshMemory,
  restoreMemoryPage,
  saveMemoryPage,
} from "../../api/memory-pages.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** A line the page shows after a change: what happened, and Undo when it can be undone. */
export interface MemoryFlash {
  readonly message: string;
  readonly tone: "done" | "failed";
  readonly undo?: (() => void) | undefined;
}

/** What a change that failed says: memory down, the page changed meanwhile, or anything else. */
export const failureFlash = (error: unknown): MemoryFlash => ({
  tone: "failed",
  message: memoryNotAnswering(error)
    ? copy.actions.notAnswering
    : memoryPageChanged(error)
      ? copy.actions.changed
      : copy.actions.failed,
});

/**
 * Every change the Memory page makes (#959), each a new version by you: save (an edit, a pin, a
 * forget day, a new page), delete and restore. A change that finds the page changed since it was
 * read writes nothing, and memory is read again, so the page shows what it holds now.
 */
export const useMemoryWrites = () => {
  const queryClient = useQueryClient();
  const onError = (error: unknown) => (memoryPageChanged(error) ? refreshMemory(queryClient) : undefined);
  const save = useMutation({
    mutationFn: saveMemoryPage,
    onSuccess: (read) => applyMemoryWrite(queryClient, read),
    onError,
  });
  const remove = useMutation({ mutationFn: deleteMemoryPage, onSuccess: () => refreshMemory(queryClient), onError });
  const restore = useMutation({
    mutationFn: restoreMemoryPage,
    onSuccess: (read) => applyMemoryWrite(queryClient, read),
    onError,
  });
  return { save, remove, restore, busy: save.isPending || remove.isPending || restore.isPending };
};

export type MemoryWrites = ReturnType<typeof useMemoryWrites>;
