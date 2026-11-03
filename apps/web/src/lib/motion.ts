import { useSyncExternalStore } from "react";
import { readStored, removeStored, writeStored } from "./storage.ts";

/**
 * Reduce motion on this device: `system` follows the system setting, `reduce` stops every
 * animation, `full` lets them play. It belongs to the screen it is set on, not to the hub, so each
 * device keeps its own (UX-003).
 */
export type MotionChoice = "system" | "reduce" | "full";

const STORAGE_KEY = "hobbots.motion";
const QUERY = "(prefers-reduced-motion: reduce)";

const isChoice = (value: unknown): value is Exclude<MotionChoice, "system"> => value === "reduce" || value === "full";

/** Whether motion stops, given this device's choice and what the system asks for. */
export const reducesMotion = (choice: MotionChoice, systemReduces: boolean): boolean =>
  choice === "system" ? systemReduces : choice === "reduce";

/** The choice the switch makes: back to `system` when it matches what the system asks for anyway. */
export const choiceFor = (reduce: boolean, systemReduces: boolean): MotionChoice =>
  reduce === systemReduces ? "system" : reduce ? "reduce" : "full";

export interface MotionState {
  readonly choice: MotionChoice;
  readonly systemReduces: boolean;
  readonly reduced: boolean;
}

/** Where the motion store reads and keeps the choice; each part may be missing or fail. */
export interface MotionEnvironment {
  /** The saved choice, or null; it answers null when storage cannot be read. */
  readonly read: () => unknown;
  /** Saves the choice; best effort, so a failure changes nothing on the page. */
  readonly write: (choice: Exclude<MotionChoice, "system">) => void;
  readonly remove: () => void;
  readonly systemReduces: () => boolean;
  /** Marks the page so the styles stop or allow motion; `system` leaves it to the media query. */
  readonly mark: (choice: MotionChoice) => void;
}

/**
 * The device's motion choice, held in memory so the styles, the switch and scripted motion always
 * agree. Storage only carries it across reloads and windows: a read or write that fails leaves the
 * choice in memory as it is.
 */
export const createMotionStore = (environment: MotionEnvironment) => {
  const stored = (): MotionChoice => {
    const value = environment.read();
    return isChoice(value) ? value : "system";
  };
  let choice = stored();
  let snapshot: MotionState | undefined;
  const listeners = new Set<() => void>();

  const state = (): MotionState => {
    const system = environment.systemReduces();
    if (snapshot?.choice !== choice || snapshot.systemReduces !== system) {
      snapshot = { choice, systemReduces: system, reduced: reducesMotion(choice, system) };
    }
    return snapshot;
  };
  const changed = () => {
    environment.mark(choice);
    for (const listener of listeners) listener();
  };

  environment.mark(choice);
  return {
    state,
    set: (next: MotionChoice) => {
      choice = next;
      if (next === "system") environment.remove();
      else environment.write(next);
      changed();
    },
    /** The system's setting changed: the choice stays, and what it means is read again. */
    systemChanged: changed,
    /** Another window on this device saved a choice. */
    storageChanged: () => {
      choice = stored();
      changed();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

const pageEnvironment: MotionEnvironment = {
  read: () => readStored<unknown>(STORAGE_KEY, null),
  write: (choice) => writeStored(STORAGE_KEY, choice),
  remove: () => removeStored(STORAGE_KEY),
  systemReduces: () => globalThis.matchMedia?.(QUERY).matches ?? false,
  mark: (choice) => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    if (choice === "system") delete root.dataset.motion;
    else root.dataset.motion = choice;
  },
};

const store = createMotionStore(pageEnvironment);

/** Saves this device's choice and applies it at once. */
export const setMotionChoice = store.set;

/** Follows changes from the system and from other windows on this device. */
export const followMotionChoice = () => {
  globalThis.matchMedia?.(QUERY).addEventListener("change", store.systemChanged);
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) store.storageChanged();
  });
};

/** Whether motion stops right now. Motion driven from script checks this (STD-UI-004). */
export const motionReduced = (): boolean => store.state().reduced;

/** This device's motion choice, what the system asks for, and whether motion stops. */
export const useMotion = (): MotionState => useSyncExternalStore(store.subscribe, store.state, store.state);
