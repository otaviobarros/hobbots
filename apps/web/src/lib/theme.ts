import { useLayoutEffect, useSyncExternalStore } from "react";
import { type ChoiceEnvironment, createChoiceStore } from "./device-choice.ts";
import { readStored, writeStored } from "./storage.ts";

/** The four themes, by their `data-theme` value (docs/design/themes.md). */
export const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

export type Theme = (typeof THEMES)[number];

/** The two looks, each with a dark and a light theme. */
export type Look = "lamplight" | "workshop";

export type Mode = "dark" | "light";

/** The look a theme belongs to. */
export const lookOf = (theme: Theme): Look => (theme.startsWith("workshop") ? "workshop" : "lamplight");

/** Whether a theme is dark or light. */
export const modeOf = (theme: Theme): Mode =>
  theme === "lamplight-dusk" || theme === "workshop-night" ? "dark" : "light";

const THEME_OF: Readonly<Record<Look, Readonly<Record<Mode, Theme>>>> = {
  lamplight: { dark: "lamplight-dusk", light: "lamplight-paper" },
  workshop: { dark: "workshop-night", light: "workshop-daylight" },
};

/** The theme a look shows in a mode: Lamplight Dusk, Lamplight Paper, Workshop Night or Workshop Daylight. */
export const themeOf = (look: Look, mode: Mode): Theme => THEME_OF[look][mode];

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
export type ThemeEnvironment = ChoiceEnvironment<Theme>;

/**
 * This device's theme, held in memory so the page and the picker always agree. Like Reduce motion
 * it belongs to the screen it is picked on, not to the hub. Storage only carries it across restarts
 * and windows: a value that is missing or unknown means Workshop Night, and a read or write that
 * fails leaves the theme in memory as it is.
 */
export const createThemeStore = (environment: ThemeEnvironment) => {
  const choice = createChoiceStore(environment, (saved) => (isTheme(saved) ? saved : FIRST_RUN_THEME));
  return {
    theme: choice.get,
    set: choice.set,
    /**
     * First run finished on this device: with no theme saved yet, it keeps Lamplight Dusk from the
     * next start. This window stays as it is, so first run shows Workshop Night to the end.
     */
    firstRunFinished: () => {
      if (!isTheme(environment.read())) environment.write(NEW_DEVICE_THEME);
    },
    /**
     * Shows Workshop Night while a first run screen is open, whatever theme is saved, and gives the
     * page its own theme back when it closes. The saved theme stays as it is.
     */
    holdFirstRun: () => {
      environment.mark(FIRST_RUN_THEME);
      return () => environment.mark(choice.get());
    },
    storageChanged: choice.storageChanged,
    subscribe: choice.subscribe,
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

/** Picks this device's theme, here and in every other window on it. */
export const setTheme = (theme: Theme) => store.set(theme);

/** This device's theme, kept in step with every change, here or in another window. */
export const useTheme = (): Theme => useSyncExternalStore(store.subscribe, store.theme, store.theme);

/** First run always renders in Workshop Night: call it from each first run screen. */
export const useFirstRunTheme = () => useLayoutEffect(() => store.holdFirstRun(), []);
