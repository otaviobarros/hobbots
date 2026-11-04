import { describe, expect, it, vi } from "vitest";
import { readStored, writeStored } from "./storage.ts";
import {
  choiceOf,
  createThemeStore,
  FIRST_RUN_THEME,
  lookOf,
  lookOfChoice,
  modeChoiceOf,
  modeOf,
  NEW_DEVICE_THEME,
  resolveTheme,
  THEMES,
  type Theme,
  type ThemeChoice,
  type ThemeEnvironment,
  themeOf,
} from "./theme.ts";

const environment = (overrides: Partial<ThemeEnvironment> = {}) => {
  const marks: Theme[] = [];
  const writes: ThemeChoice[] = [];
  const env: ThemeEnvironment = {
    read: () => null,
    write: (choice) => void writes.push(choice),
    mark: (theme) => void marks.push(theme),
    systemDark: () => true,
    ...overrides,
  };
  return { env, marks, writes };
};

const failing = () => {
  throw new Error("storage unavailable");
};

describe("the theme store", () => {
  it("starts in Workshop Night on first run", () => {
    const { env, marks } = environment();
    const store = createThemeStore(env);
    expect(store.theme()).toBe("workshop-night");
    expect(FIRST_RUN_THEME).toBe("workshop-night");
    expect(marks).toEqual(["workshop-night"]);
  });

  it("shows Workshop Night on a first run screen whatever is saved, and gives the page its theme back after", () => {
    const { env, marks, writes } = environment({ read: () => "lamplight-paper" });
    const store = createThemeStore(env);
    const release = store.holdFirstRun();
    expect(marks.at(-1)).toBe("workshop-night");
    release();
    expect(marks.at(-1)).toBe("lamplight-paper");
    expect(store.theme()).toBe("lamplight-paper");
    expect(writes).toEqual([]);
  });

  it("starts from the saved theme and marks the page with it", () => {
    const { env, marks } = environment({ read: () => "lamplight-paper" });
    expect(createThemeStore(env).theme()).toBe("lamplight-paper");
    expect(marks).toEqual(["lamplight-paper"]);
  });

  it("starts in Workshop Night when the saved value is not a theme", () => {
    for (const saved of ["sepia", 3, { theme: "lamplight-dusk" }]) {
      const { env } = environment({ read: () => saved });
      expect(createThemeStore(env).theme(), String(saved)).toBe("workshop-night");
    }
  });

  it("saves a picked theme, applies it and tells its readers", () => {
    const { env, marks, writes } = environment();
    const store = createThemeStore(env);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("workshop-daylight");
    expect(store.theme()).toBe("workshop-daylight");
    expect(writes).toEqual(["workshop-daylight"]);
    expect(marks).toEqual(["workshop-night", "workshop-daylight"]);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    store.set("lamplight-dusk");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("survives a restart through storage", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    });
    const page = () =>
      environment({
        read: () => readStored<unknown>("hobbots.theme", null),
        write: (theme) => writeStored("hobbots.theme", theme),
      }).env;
    createThemeStore(page()).set("lamplight-dusk");
    expect(createThemeStore(page()).theme()).toBe("lamplight-dusk");
    vi.unstubAllGlobals();
  });

  it("follows a theme saved in another window", () => {
    let saved: unknown = null;
    const { env, marks } = environment({ read: () => saved });
    const store = createThemeStore(env);
    saved = "lamplight-paper";
    store.storageChanged();
    expect(store.theme()).toBe("lamplight-paper");
    expect(marks).toEqual(["workshop-night", "lamplight-paper"]);
  });

  it("keeps the theme in memory when storage cannot be read or written", () => {
    vi.stubGlobal("localStorage", { getItem: failing, setItem: failing });
    const { env, marks } = environment({
      read: () => readStored<unknown>("hobbots.theme", null),
      write: (theme) => writeStored("hobbots.theme", theme),
    });
    const store = createThemeStore(env);
    expect(store.theme()).toBe("workshop-night");
    store.set("workshop-daylight");
    expect(store.theme()).toBe("workshop-daylight");
    expect(marks).toEqual(["workshop-night", "workshop-daylight"]);
    vi.unstubAllGlobals();
  });

  it("keeps Lamplight Dusk from the next start when first run finishes with no saved theme", () => {
    let saved: unknown = null;
    const { env, marks } = environment({
      read: () => saved,
      write: (theme) => {
        saved = theme;
      },
    });
    const store = createThemeStore(env);
    store.firstRunFinished();
    expect(saved).toBe("lamplight-dusk");
    expect(NEW_DEVICE_THEME).toBe("lamplight-dusk");
    // First run shows Workshop Night to the end; the saved theme applies at the next start.
    expect(store.theme()).toBe("workshop-night");
    expect(marks).toEqual(["workshop-night"]);
    expect(createThemeStore(env).theme()).toBe("lamplight-dusk");
  });

  it("keeps a theme already saved when first run finishes", () => {
    const { env, writes } = environment({ read: () => "workshop-daylight" });
    createThemeStore(env).firstRunFinished();
    expect(writes).toEqual([]);
  });

  it("keeps Workshop Night for a device that finished setup with nothing saved", () => {
    // Setup is done, so first run never finishes again here: nothing saved still means Workshop Night.
    const { env } = environment({ read: () => null });
    expect(createThemeStore(env).theme()).toBe("workshop-night");
  });
});

describe("Automatic", () => {
  it("shows the look's dark or light theme as the system asks, and follows it when it changes", () => {
    let dark = false;
    const { env, marks, writes } = environment({ systemDark: () => dark });
    const store = createThemeStore(env);
    store.set("lamplight-auto");
    expect(writes).toEqual(["lamplight-auto"]);
    expect(store.choice()).toBe("lamplight-auto");
    expect(store.theme()).toBe("lamplight-paper");
    dark = true;
    store.systemChanged();
    expect(store.theme()).toBe("lamplight-dusk");
    expect(marks).toEqual(["workshop-night", "lamplight-paper", "lamplight-dusk"]);
  });

  it("starts from a saved Automatic", () => {
    const { env, marks } = environment({ read: () => "workshop-auto", systemDark: () => false });
    expect(createThemeStore(env).theme()).toBe("workshop-daylight");
    expect(marks).toEqual(["workshop-daylight"]);
  });

  it("keeps Workshop Night on a first run screen when the system changes, and shows the new theme after", () => {
    let dark = true;
    const { env, marks } = environment({ read: () => "lamplight-auto", systemDark: () => dark });
    const store = createThemeStore(env);
    const release = store.holdFirstRun();
    dark = false;
    store.systemChanged();
    expect(marks.at(-1)).toBe("workshop-night");
    release();
    expect(marks.at(-1)).toBe("lamplight-paper");
  });

  it("leaves a picked Light or Dark alone when the system changes", () => {
    let dark = true;
    const { env } = environment({ read: () => "lamplight-paper", systemDark: () => dark });
    const store = createThemeStore(env);
    dark = false;
    store.systemChanged();
    expect(store.theme()).toBe("lamplight-paper");
  });

  it("names a choice's look and mode, and finds the choice again from them", () => {
    expect(choiceOf("workshop", "auto")).toBe("workshop-auto");
    expect(choiceOf("lamplight", "dark")).toBe("lamplight-dusk");
    expect(modeChoiceOf("lamplight-auto")).toBe("auto");
    expect(modeChoiceOf("workshop-daylight")).toBe("light");
    expect(lookOfChoice("workshop-auto")).toBe("workshop");
    expect(resolveTheme("workshop-auto", true)).toBe("workshop-night");
    expect(resolveTheme("lamplight-paper", true)).toBe("lamplight-paper");
  });
});

describe("looks and modes", () => {
  it("names each theme's look and mode, and finds the theme again from them", () => {
    for (const theme of THEMES) expect(themeOf(lookOf(theme), modeOf(theme))).toBe(theme);
    expect(themeOf("lamplight", "light")).toBe("lamplight-paper");
    expect(themeOf("workshop", "dark")).toBe("workshop-night");
    expect(lookOf("workshop-daylight")).toBe("workshop");
    expect(modeOf("lamplight-dusk")).toBe("dark");
  });
});
