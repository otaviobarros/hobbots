import { describe, expect, it, vi } from "vitest";
import { choiceFor, createMotionStore, type MotionChoice, type MotionEnvironment, reducesMotion } from "./motion.ts";
import { readStored, removeStored, writeStored } from "./storage.ts";

describe("Reduce motion", () => {
  it("follows the system until this device chooses", () => {
    expect(reducesMotion("system", true)).toBe(true);
    expect(reducesMotion("system", false)).toBe(false);
    expect(reducesMotion("reduce", false)).toBe(true);
    expect(reducesMotion("full", true)).toBe(false);
  });

  it("goes back to following the system when the switch matches it", () => {
    expect(choiceFor(true, true)).toBe("system");
    expect(choiceFor(false, false)).toBe("system");
    expect(choiceFor(true, false)).toBe("reduce");
    expect(choiceFor(false, true)).toBe("full");
  });
});

const environment = (overrides: Partial<MotionEnvironment> = {}) => {
  const marks: MotionChoice[] = [];
  let system = false;
  const env: MotionEnvironment = {
    read: () => null,
    write: () => {},
    remove: () => {},
    systemReduces: () => system,
    mark: (choice) => void marks.push(choice),
    ...overrides,
  };
  return { env, marks, setSystem: (on: boolean) => (system = on) };
};

const failing = () => {
  throw new Error("storage unavailable");
};

describe("the motion store", () => {
  it("starts from the saved choice and marks the page with it", () => {
    const { env, marks } = environment({ read: () => "reduce" });
    const store = createMotionStore(env);
    expect(store.state()).toEqual({ choice: "reduce", systemReduces: false, reduced: true });
    expect(marks).toEqual(["reduce"]);
  });

  it("keeps the choice in memory when storage cannot be written, read or cleared", () => {
    // Storage that throws on every call, through the page's own storage helpers.
    vi.stubGlobal("localStorage", {
      getItem: failing,
      setItem: failing,
      removeItem: failing,
    });
    const { env, marks, setSystem } = environment({
      read: () => readStored<unknown>("hobbots.motion", null),
      write: (choice) => writeStored("hobbots.motion", choice),
      remove: () => removeStored("hobbots.motion"),
    });
    const store = createMotionStore(env);
    store.set("reduce");
    expect(store.state().reduced).toBe(true);
    expect(marks.at(-1)).toBe("reduce");

    // A change of the system setting keeps this device's choice rather than rereading storage.
    setSystem(true);
    store.systemChanged();
    expect(store.state()).toEqual({ choice: "reduce", systemReduces: true, reduced: true });
    expect(marks.at(-1)).toBe("reduce");

    store.set("system");
    expect(store.state()).toEqual({ choice: "system", systemReduces: true, reduced: true });
    expect(marks.at(-1)).toBe("system");
    vi.unstubAllGlobals();
  });

  it("tells subscribers about each change and reads storage again when another window saves", () => {
    let saved: unknown = null;
    const { env } = environment({ read: () => saved });
    const store = createMotionStore(env);
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    saved = "full";
    store.storageChanged();
    expect(store.state().choice).toBe("full");
    expect(calls).toBe(1);
    stop();
    store.set("reduce");
    expect(calls).toBe(1);
  });
});
