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

const systemReduces = (): boolean => globalThis.matchMedia?.(QUERY).matches ?? false;

const readChoice = (): MotionChoice => {
  const stored = readStored<unknown>(STORAGE_KEY, null);
  return isChoice(stored) ? stored : "system";
};

const listeners = new Set<() => void>();

/** Marks the page so the styles stop or allow motion; `system` leaves it to the media query. */
const apply = (choice: MotionChoice) => {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (choice === "system") delete root.dataset.motion;
  else root.dataset.motion = choice;
};

/** Saves this device's choice and applies it at once. */
export const setMotionChoice = (choice: MotionChoice) => {
  if (choice === "system") removeStored(STORAGE_KEY);
  else writeStored(STORAGE_KEY, choice);
  apply(choice);
  for (const listener of listeners) listener();
};

/**
 * Applies the saved choice before the first render and follows changes from the system and from
 * other windows on this device.
 */
export const followMotionChoice = () => {
  apply(readChoice());
  const notify = () => {
    apply(readChoice());
    for (const listener of listeners) listener();
  };
  globalThis.matchMedia?.(QUERY).addEventListener("change", notify);
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) notify();
  });
};

/** Whether motion stops right now. Motion driven from script checks this (STD-UI-004). */
export const motionReduced = (): boolean => reducesMotion(readChoice(), systemReduces());

interface MotionState {
  readonly choice: MotionChoice;
  readonly systemReduces: boolean;
  readonly reduced: boolean;
}

let snapshot: MotionState | undefined;
const currentState = (): MotionState => {
  const choice = readChoice();
  const system = systemReduces();
  if (snapshot?.choice !== choice || snapshot.systemReduces !== system) {
    snapshot = { choice, systemReduces: system, reduced: reducesMotion(choice, system) };
  }
  return snapshot;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** This device's motion choice, what the system asks for, and whether motion stops. */
export const useMotion = (): MotionState => useSyncExternalStore(subscribe, currentState, currentState);
