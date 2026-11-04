import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage.ts";

/** The four themes, by their `data-theme` value (docs/design/themes.md). */
export const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

export type Theme = (typeof THEMES)[number];

/** The theme a device shows until a theme is picked on it: first run always uses Workshop Night. */
export const FIRST_RUN_THEME: Theme = "workshop-night";

/**
 * The theme a device keeps once its first run finishes, when nothing was picked on it during
 * setup. A device with no saved theme that finished setup before this rule stays on Workshop Night.
 */
export const NEW_DEVICE_THEME: Theme = "lamplight-dusk";

const STORAGE_KEY = "hobbots.theme";

const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value);

/** Where the theme store reads and keeps the choice; each part may be missing or fail. */
export interface ThemeEnvironment {
  /** The saved theme, or null; it answers null when storage cannot be read. */
  readonly read: () => unknown;
  /** Saves the theme; best effort, so a failure changes nothing on the page. */
  readonly write: (theme: Theme) => void;
  /** Sets the theme on the page, so every screen restyles at once. */
  readonly mark: (theme: Theme) => void;
}

/**
 * This device's theme, held in memory so the page and the picker always agree. Like Reduce motion
 * it belongs to the screen it is picked on, not to the hub. Storage only carries it across restarts
 * and windows: a value that is missing or unknown means Workshop Night, and a read or write that
 * fails leaves the theme in memory as it is.
 */
export const createThemeStore = (environment: ThemeEnvironment) => {
  const stored = (): Theme => {
    const value = environment.read();
    return isTheme(value) ? value : FIRST_RUN_THEME;
  };
  let theme = stored();
  const listeners = new Set<() => void>();

  const apply = (next: Theme) => {
    theme = next;
    environment.mark(next);
    for (const listener of listeners) listener();
  };

  environment.mark(theme);
  return {
    theme: (): Theme => theme,
    set: (next: Theme) => {
      environment.write(next);
      apply(next);
    },
    /**
     * First run finished on this device: with no theme saved yet, it keeps Lamplight Dusk from the
     * next start. This window stays as it is, so first run shows Workshop Night to the end.
     */
    firstRunFinished: () => {
      if (!isTheme(environment.read())) environment.write(NEW_DEVICE_THEME);
    },
    /** Another window on this device saved a theme. */
    storageChanged: () => apply(stored()),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const pageEnvironment: ThemeEnvironment = {
  read: () => readStored<unknown>(STORAGE_KEY, null),
  write: (theme) => writeStored(STORAGE_KEY, theme),
  mark: (theme) => {
    const root = globalThis.document?.documentElement;
    if (root) root.dataset.theme = theme;
  },
};

/**
 * Created when the module loads, so the saved theme is on the page before the first render. The
 * theme picker in Settings saves through `set` and reads `theme`.
 */
const store = createThemeStore(pageEnvironment);

/** Saves Lamplight Dusk for the next start when first run finishes on a device with no saved theme. */
export const firstRunFinished = store.firstRunFinished;

/** Follows a theme picked in another window on this device. */
export const followThemeChoice = () => {
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) store.storageChanged();
  });
};

/** This device's theme, kept in step with every change, here or in another window. */
export const useTheme = (): Theme => useSyncExternalStore(store.subscribe, store.theme, store.theme);
