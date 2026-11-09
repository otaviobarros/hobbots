import { useSyncExternalStore } from "react";

/**
 * The folder the person chose under Backups, shared with Start over's Back up first (#948), so both
 * save to the same place. Null until they choose one: the hub's default folder applies then. It
 * lives in memory only, as the field did before, so a reload goes back to the default.
 */
let chosen: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const chooseBackupFolder = (folder: string) => {
  chosen = folder;
  for (const listener of listeners) listener();
};

/** The folder backups save to: the one chosen under Backups, or else `fallback`, the hub's default. */
export const useBackupFolder = (fallback: string | undefined) => useChosenBackupFolder() ?? fallback ?? "";

/** The folder chosen under Backups, or null while backups go to the hub's default folder. */
export const useChosenBackupFolder = (): string | null => useSyncExternalStore(subscribe, () => chosen);
