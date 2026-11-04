import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage.ts";

/**
 * How big Hobbots draws on this device: `standard`, or `larger`, which scales the whole app up by an
 * eighth. Like the theme it belongs to the screen it is picked on, not to the hub.
 */
export const TEXT_SIZES = ["standard", "larger"] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

const STORAGE_KEY = "hobbots.text-size";

const isTextSize = (value: unknown): value is TextSize => TEXT_SIZES.some((size) => size === value);

/** Where the text size store reads and keeps the choice; each part may be missing or fail. */
export interface TextSizeEnvironment {
  /** The saved size, or null; it answers null when storage cannot be read. */
  readonly read: () => unknown;
  /** Saves the size; best effort, so a failure changes nothing on the page. */
  readonly write: (size: TextSize) => void;
  /** Sets the size on the page, so every screen scales at once. */
  readonly mark: (size: TextSize) => void;
}

/**
 * This device's text size, held in memory so the page and the picker agree. A saved value that is
 * missing or unknown means Standard, and a read or write that fails leaves the size as it is.
 */
export const createTextSizeStore = (environment: TextSizeEnvironment) => {
  const stored = (): TextSize => {
    const value = environment.read();
    return isTextSize(value) ? value : "standard";
  };
  let size = stored();
  const listeners = new Set<() => void>();
  const apply = (next: TextSize) => {
    size = next;
    environment.mark(next);
    for (const listener of listeners) listener();
  };
  environment.mark(size);
  return {
    size: (): TextSize => size,
    set: (next: TextSize) => {
      environment.write(next);
      apply(next);
    },
    /** Another window on this device saved a size. */
    storageChanged: () => apply(stored()),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const pageEnvironment: TextSizeEnvironment = {
  read: () => readStored<unknown>(STORAGE_KEY, null),
  write: (size) => writeStored(STORAGE_KEY, size),
  mark: (size) => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    if (size === "larger") root.dataset.textSize = size;
    else delete root.dataset.textSize;
  },
};

// Created when the module loads, so a saved size is on the page before the first render.
const store = createTextSizeStore(pageEnvironment);

/** Picks this device's text size, here and in every other window on it. */
export const setTextSize = store.set;

/** Follows a size picked in another window on this device. */
export const followTextSizeChoice = () => {
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) store.storageChanged();
  });
};

/** This device's text size, kept in step with every change, here or in another window. */
export const useTextSize = (): TextSize => useSyncExternalStore(store.subscribe, store.size, store.size);
