import { coalesce } from "./coalesce.ts";
import { type ReadUntilOptions, readUntil } from "./read-until.ts";

/** A hob with a turn in progress, and the thread it runs in. */
export interface WorkingHob {
  readonly threadId: string;
  readonly name: string;
}

export interface WorkingHobsOptions {
  /** Reads the hobs with a turn in progress, or answers null when the hub did not answer. */
  readonly read: () => Promise<ReadonlyArray<WorkingHob> | null>;
  /** Receives each read that answered. */
  readonly onRead: (hobs: ReadonlyArray<WorkingHob>) => void;
  readonly retry?: ReadUntilOptions;
}

/**
 * Keeps which hobs are working in step with the event stream. A reply's event can arrive before the
 * hub registers its turn, or before it removes the ended one, so a read that disagrees with the
 * latest event for a thread is made again until it agrees, or until the retries run out and the read
 * stands. A read that did not answer is made again the same way.
 */
export const workingHobs = ({ read, onRead, retry }: WorkingHobsOptions) => {
  // Each thread's working state as its latest event reported it, until a read has been checked against it.
  const expected = new Map<string, boolean>();

  const refresh = coalesce(async () => {
    const awaited = new Map(expected);
    const agrees = (hobs: ReadonlyArray<WorkingHob>) =>
      [...awaited].every(([threadId, working]) => hobs.some((hob) => hob.threadId === threadId) === working);
    const hobs = await readUntil(read, agrees, retry);
    // An event that came during the read stays for the read the coalesced call makes next.
    for (const [threadId, working] of awaited) if (expected.get(threadId) === working) expected.delete(threadId);
    if (hobs !== null) onRead(hobs);
  });

  /** A reply's event said whether its thread's turn is in progress. */
  const changed = (threadId: string, working: boolean) => {
    expected.set(threadId, working);
    return refresh();
  };

  return { changed, refresh };
};
