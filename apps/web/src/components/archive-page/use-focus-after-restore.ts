import type { ThreadId } from "@hobbots/domain";
import { focusElement } from "@hobbots/ui/lib/restore-focus";
import { useEffect, useRef, useState } from "react";
import type { ArchivedChat } from "./archive-model.ts";

/**
 * Where focus goes once a chat restored from the list leaves it, so it never drops to the page
 * (WCAG 2.4.3): to the Restore of the row that takes its place, to the one before when it was the
 * last row, or to the empty list's heading when it was the only one.
 */
export const useFocusAfterRestore = (shown: ReadonlyArray<ArchivedChat>) => {
  const buttons = useRef(new Map<ThreadId, HTMLButtonElement>());
  const empty = useRef<HTMLHeadingElement>(null);
  const [left, setLeft] = useState<{ readonly id: ThreadId; readonly index: number } | null>(null);

  useEffect(() => {
    // The chat leaves the list once the restore lands; until then focus stays on its Restore.
    if (left === null || shown.some((chat) => chat.thread.id === left.id)) return;
    setLeft(null);
    const next = shown[Math.min(left.index, shown.length - 1)];
    const button = next && buttons.current.get(next.thread.id);
    if (button) button.focus();
    else if (empty.current) focusElement(empty.current);
  }, [left, shown]);

  return {
    /** Keeps each row's Restore, so focus can move to it. */
    button: (id: ThreadId) => (element: HTMLButtonElement | null) => {
      if (element) buttons.current.set(id, element);
      else buttons.current.delete(id);
    },
    /** The heading the list shows once it is empty. */
    empty,
    /** Call once this chat is restored, with where it stood in the list. */
    restored: (id: ThreadId) => setLeft({ id, index: shown.findIndex((chat) => chat.thread.id === id) }),
  };
};
