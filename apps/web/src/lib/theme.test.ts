import { describe, expect, it, vi } from "vitest";
import { readStored, writeStored } from "./storage.ts";
import { createThemeStore, FIRST_RUN_THEME, type Theme, type ThemeEnvironment } from "./theme.ts";

const environment = (overrides: Partial<ThemeEnvironment> = {}) => {
  const marks: Theme[] = [];
  const writes: Theme[] = [];
  const env: ThemeEnvironment = {
    read: () => null,
    write: (theme) => void writes.push(theme),
    mark: (theme) => void marks.push(theme),
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
});
