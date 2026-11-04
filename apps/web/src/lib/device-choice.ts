/** Where a device choice is read, kept and shown; each part may be missing or fail. */
export interface ChoiceEnvironment<T> {
  /** The saved value, or null; it answers null when storage cannot be read. */
  readonly read: () => unknown;
  /** Saves the value; best effort, so a failure changes nothing on the page. */
  readonly write: (value: T) => void;
  /** Sets the value on the page, so every screen follows at once. */
  readonly mark: (value: T) => void;
}

/**
 * A choice that belongs to this device, such as the theme or the text size, held in memory so the
 * page and its picker always agree. Storage only carries it across restarts and windows: `parse`
 * turns a missing or unknown saved value into the default, and a read or write that fails leaves the
 * value in memory as it is. The saved value is marked on the page as soon as the store is made.
 */
export const createChoiceStore = <T>(environment: ChoiceEnvironment<T>, parse: (saved: unknown) => T) => {
  const stored = () => parse(environment.read());
  let value = stored();
  const listeners = new Set<() => void>();
  const apply = (next: T) => {
    value = next;
    environment.mark(next);
    for (const listener of listeners) listener();
  };
  environment.mark(value);
  return {
    get: (): T => value,
    set: (next: T) => {
      environment.write(next);
      apply(next);
    },
    /** Another window on this device saved a value. */
    storageChanged: () => apply(stored()),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
