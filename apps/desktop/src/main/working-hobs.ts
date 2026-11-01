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
 * hub registers its turn, or well before it removes the ended one, so a read that disagrees with the
 * latest event for a thread is made again until it agrees. A read that did not answer is made again
 * the same way. Only a read that agrees is shown.
 */
export const workingHobs = ({ read, onRead, retry }: WorkingHobsOptions) => {
  // Each thread's working state as its latest event reported it, until a read agrees with it.
  const expected = new Map<string, boolean>();
  // Each answer is checked against the latest events, so one that came meanwhile is waited for too.
  const shows = (hobs: ReadonlyArray<WorkingHob>, threadId: string) => hobs.some((hob) => hob.threadId === threadId);
  const agrees = (hobs: ReadonlyArray<WorkingHob>) =>
    [...expected].every(([threadId, working]) => shows(hobs, threadId) === working);

  const refresh = coalesce(async () => {
    const hobs = await readUntil(read, agrees, retry);
    // An event that came after the read stays for the read the coalesced call makes next.
    for (const [threadId, working] of expected) if (shows(hobs, threadId) === working) expected.delete(threadId);
    onRead(hobs);
  });

  /** A reply's event said whether its thread's turn is in progress. */
  const changed = (threadId: string, working: boolean) => {
    expected.set(threadId, working);
    return refresh();
  };

  /**
   * Forgets what events said, for a fresh connection or a hub that went away: the next read that
   * answers stands, as a new snapshot.
   */
  const reset = () => {
    expected.clear();
    return refresh();
  };

  return { changed, refresh, reset };
};
