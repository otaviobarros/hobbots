/**
 * Wraps an async task so its runs never overlap. A call made while it runs makes it run once more
 * afterwards, so the last call always sees the newest state, however many calls came meanwhile.
 * Every call resolves once the task has run after it.
 */
export const coalesce = (task: () => Promise<void>) => {
  let running: Promise<void> | null = null;
  let again = false;
  return (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
};
