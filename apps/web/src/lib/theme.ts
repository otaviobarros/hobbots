import { readStored, writeStored } from "./storage.ts";

/** The four themes, by their `data-theme` value (docs/design/themes.md). */
export const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

export type Theme = (typeof THEMES)[number];

/** The theme a device shows until a theme is picked on it: first run always uses Workshop Night. */
export const FIRST_RUN_THEME: Theme = "workshop-night";

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

/** Follows a theme picked in another window on this device. */
export const followThemeChoice = () => {
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) store.storageChanged();
  });
};
