import { useSyncExternalStore } from "react";
import { readStored, removeStored, writeStored } from "../lib/storage.ts";
import type { WaitingPlace } from "./outbox.ts";

/**
 * The unsent text of each thread and fresh page. It lives outside the chat, so switching threads
 * keeps it, and in browser storage, so a reload keeps it too. Typing changes memory at once and
 * storage a moment later, so a long draft stays quick to type in; a cleared draft leaves storage at
 * once, so a reload never brings back a message just sent, and leaving the page saves what waits.
 * Like the outbox, it is a store outside React because it must outlive each thread's chat view.
 */
const drafts = new Map<WaitingPlace, string>();
const saving = new Map<WaitingPlace, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const SAVE_DELAY_MS = 300;

const storageKey = (place: WaitingPlace) => `draft.${place}`;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const readDraft = (place: WaitingPlace): string => {
  const known = drafts.get(place);
  if (known !== undefined) return known;
  const stored = readStored<unknown>(storageKey(place), "");
  const text = typeof stored === "string" ? stored : "";
  drafts.set(place, text);
  return text;
};

const save = (place: WaitingPlace) => {
  clearTimeout(saving.get(place));
  saving.delete(place);
  const text = drafts.get(place) ?? "";
  if (text === "") removeStored(storageKey(place));
  else writeStored(storageKey(place), text);
};

/** Saves every draft still waiting for its delayed save, as when the page is closing. */
export const saveDrafts = () => {
  for (const place of [...saving.keys()]) save(place);
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", saveDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveDrafts();
  });
}

export const writeDraft = (place: WaitingPlace, text: string) => {
  if (readDraft(place) === text) return;
  drafts.set(place, text);
  for (const listener of listeners) listener();
  if (text === "") {
    save(place);
    return;
  }
  clearTimeout(saving.get(place));
  saving.set(
    place,
    setTimeout(() => save(place), SAVE_DELAY_MS),
  );
};

export const useDraft = (place: WaitingPlace): string => useSyncExternalStore(subscribe, () => readDraft(place));

/** A send that failed puts its text back in front of anything typed since. */
export const restoreDraft = (place: WaitingPlace, content: string) => {
  const now = readDraft(place);
  writeDraft(place, now.trim() === "" ? content : `${content}\n${now}`);
};

/** A waiting message taken back to edit goes after anything typed since. */
export const appendDraft = (place: WaitingPlace, content: string) => {
  const now = readDraft(place);
  writeDraft(place, now.trim() === "" ? content : `${now}\n${content}`);
};

/** A fresh page that became a thread takes its unsent text along. */
export const moveDraft = (from: WaitingPlace, to: WaitingPlace) => {
  const text = readDraft(from);
  if (text === "") return;
  writeDraft(from, "");
  writeDraft(to, readDraft(to) === "" ? text : `${readDraft(to)}\n${text}`);
};

/**
 * What a draft sends: exactly what was typed, minus blank lines before it and whitespace after it.
 * Indentation on the first line stays.
 */
export const sendable = (draft: string): string => draft.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
