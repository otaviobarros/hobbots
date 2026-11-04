import { useLayoutEffect, useSyncExternalStore } from "react";
import { createChoiceStore } from "./device-choice.ts";
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

const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value);

/** Light, Dark, or Automatic, which follows the system's `prefers-color-scheme`. */
export type ModeChoice = Mode | "auto";

/** What a device keeps: one of the four themes, or a look that follows the system's light or dark. */
export type ThemeChoice = Theme | `${Look}-auto`;

const AUTO_CHOICES: ReadonlyArray<ThemeChoice> = ["lamplight-auto", "workshop-auto"];

/** The look a choice shows. */
export const lookOfChoice = (choice: ThemeChoice): Look => (choice.startsWith("workshop") ? "workshop" : "lamplight");

/** Whether a choice is Light, Dark or Automatic. */
export const modeChoiceOf = (choice: ThemeChoice): ModeChoice => (isTheme(choice) ? modeOf(choice) : "auto");

/** The choice for a look and a mode, Automatic included. */
export const choiceOf = (look: Look, mode: ModeChoice): ThemeChoice =>
  mode === "auto" ? `${look}-auto` : themeOf(look, mode);

/** The theme a choice shows: Automatic shows the dark theme while the system is dark. */
export const resolveTheme = (choice: ThemeChoice, systemDark: boolean): Theme =>
  isTheme(choice) ? choice : themeOf(lookOfChoice(choice), systemDark ? "dark" : "light");

/** The theme a device shows until a theme is picked on it: first run always uses Workshop Night. */
export const FIRST_RUN_THEME: Theme = "workshop-night";

/**
 * The theme a device keeps once its first run finishes, when nothing was picked on it during
 * setup. A device with no saved theme that finished setup before this rule stays on Workshop Night.
 */
export const NEW_DEVICE_THEME: Theme = "lamplight-dusk";

const STORAGE_KEY = "hobbots.theme";

const isChoice = (value: unknown): value is ThemeChoice =>
  isTheme(value) || AUTO_CHOICES.some((choice) => choice === value);

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Where the theme store reads and keeps the choice; each part may be missing or fail. */
export interface ThemeEnvironment {
  /** The saved choice, or null; it answers null when storage cannot be read. */
  readonly read: () => unknown;
  /** Saves the choice; best effort, so a failure changes nothing on the page. */
  readonly write: (choice: ThemeChoice) => void;
  /** Sets the theme on the page, so every screen follows at once. */
  readonly mark: (theme: Theme) => void;
  /** Whether the system asks for dark, which Automatic follows. */
  readonly systemDark: () => boolean;
}

/**
 * This device's theme, held in memory so the page and the picker always agree. Like Reduce motion
 * it belongs to the screen it is picked on, not to the hub. Storage only carries it across restarts
 * and windows: a value that is missing or unknown means Workshop Night, and a read or write that
 * fails leaves the theme in memory as it is. Automatic shows the look's dark or light theme as the
 * system asks, and changes with it.
 */
export const createThemeStore = (environment: ThemeEnvironment) => {
  // While a first run screen holds Workshop Night, changes are kept but not shown.
  let held = false;
  const theme = (): Theme => resolveTheme(choice.get(), environment.systemDark());
  const choice = createChoiceStore<ThemeChoice>(
    {
      read: environment.read,
      write: environment.write,
      mark: (next) => {
        if (!held) environment.mark(resolveTheme(next, environment.systemDark()));
      },
    },
    (saved) => (isChoice(saved) ? saved : FIRST_RUN_THEME),
  );
  return {
    theme,
    choice: choice.get,
    set: choice.set,
    /**
     * First run finished on this device: with no theme saved yet, it keeps Lamplight Dusk from the
     * next start. This window stays as it is, so first run shows Workshop Night to the end.
     */
    firstRunFinished: () => {
      if (!isChoice(environment.read())) environment.write(NEW_DEVICE_THEME);
    },
    /**
     * Shows Workshop Night while a first run screen is open, whatever theme is saved, and gives the
     * page its own theme back when it closes. The saved theme stays as it is.
     */
    holdFirstRun: () => {
      held = true;
      environment.mark(FIRST_RUN_THEME);
      return () => {
        held = false;
        environment.mark(theme());
      };
    },
    /** The system switched between light and dark: Automatic follows it. */
    systemChanged: choice.refresh,
    storageChanged: choice.storageChanged,
    subscribe: choice.subscribe,
  };
};

const pageEnvironment: ThemeEnvironment = {
  read: () => readStored<unknown>(STORAGE_KEY, null),
  write: (choice) => writeStored(STORAGE_KEY, choice),
  mark: (theme) => {
    const root = globalThis.document?.documentElement;
    if (root) root.dataset.theme = theme;
  },
  systemDark: () => globalThis.matchMedia?.(DARK_QUERY).matches ?? false,
};

/**
 * Created when the module loads, so the saved theme is on the page before the first render. The
 * theme picker in Settings saves through `set` and reads `theme`.
 */
const store = createThemeStore(pageEnvironment);

/** Saves Lamplight Dusk for the next start when first run finishes on a device with no saved theme. */
export const firstRunFinished = store.firstRunFinished;

/** Follows a theme picked in another window on this device, and the system's light or dark for Automatic. */
export const followThemeChoice = () => {
  const system = globalThis.matchMedia?.(DARK_QUERY);
  system?.addEventListener("change", store.systemChanged);
  globalThis.addEventListener?.("storage", ({ key }) => {
    if (key === null || key === STORAGE_KEY) store.storageChanged();
  });
};

/** Picks this device's theme, or Automatic for a look, here and in every other window on it. */
export const setTheme = (choice: ThemeChoice) => store.set(choice);

/** What was picked on this device, Automatic included. */
export const useThemeChoice = (): ThemeChoice => useSyncExternalStore(store.subscribe, store.choice, store.choice);

/** First run always renders in Workshop Night: call it from each first run screen. */
export const useFirstRunTheme = () => useLayoutEffect(() => store.holdFirstRun(), []);
