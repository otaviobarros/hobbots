import { Schema } from "effect";
import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { readStored, writeStored } from "../../lib/storage.ts";

const HEIGHT_KEY = "room.dock";

/** The dock's height this device remembers, versioned so a later shape can tell it apart (STD-REACT-026). */
const StoredHeight = Schema.Struct({ v: Schema.Literal(1), height: Schema.Number });

/** The open dock's height when none is kept: tall enough to read a diff without scrolling at once. */
export const DOCK_HEIGHT = 420;
/** The least an open dock takes: its strip and a few rows. */
export const DOCK_MIN = 180;
/** The most of the room the dock takes, so the lanes keep a row of their work. */
const DOCK_MAX_SHARE = 0.8;
/** How far an arrow key moves the dock's edge. */
const KEY_STEP = 32;

/** A height kept within what the dock may take of a room this tall. */
export const clampHeight = (height: number, room: number): number =>
  Math.round(Math.min(Math.max(height, DOCK_MIN), Math.max(DOCK_MIN, room * DOCK_MAX_SHARE)));

export const parseHeight = (stored: unknown): number => (Schema.is(StoredHeight)(stored) ? stored.height : DOCK_HEIGHT);

/** The height a key on the dock's edge moves it to, or null for a key that does not move it. */
export const keyedHeight = (key: string, height: number, room: number): number | null => {
  switch (key) {
    case "ArrowUp":
      return clampHeight(height + KEY_STEP, room);
    case "ArrowDown":
      return clampHeight(height - KEY_STEP, room);
    case "Home":
      return clampHeight(DOCK_MIN, room);
    case "End":
      return clampHeight(Number.POSITIVE_INFINITY, room);
    default:
      return null;
  }
};

/** How tall the room is around the dock's edge, for the most it may take. */
const roomHeight = (edge: Element): number =>
  edge.closest("section[aria-label]")?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;

/**
 * The open dock's height (ADR 027): its top edge is dragged, or moved with the arrow keys, to make it
 * taller or shorter, and the device keeps the height it was left at. Expand, or a double click on
 * the edge, makes it as tall as the room lets it be, and again takes it back to where it was.
 */
export const useDockHeight = () => {
  const [height, setHeight] = useState(() => parseHeight(readStored<unknown>(HEIGHT_KEY, null)));
  // The height Expand left, kept while the dock is expanded so it can go back to it.
  const [restore, setRestore] = useState<number | null>(null);
  const keep = (next: number) => {
    setRestore(null);
    setHeight(next);
    writeStored(HEIGHT_KEY, { v: 1, height: next });
  };
  /** Expand to the most the room allows, or back to the height the dock had before. */
  const toggle = (from: Element) => {
    const room = roomHeight(from);
    if (restore !== null) {
      keep(clampHeight(restore, room));
      return;
    }
    setRestore(height);
    setHeight(clampHeight(Number.POSITIVE_INFINITY, room));
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const edge = event.currentTarget;
    const room = roomHeight(edge);
    const startY = event.clientY;
    const startHeight = height;
    edge.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => setHeight(clampHeight(startHeight + startY - moved.clientY, room));
    const end = (ended: globalThis.PointerEvent) => {
      edge.removeEventListener("pointermove", move);
      edge.removeEventListener("pointerup", end);
      edge.removeEventListener("pointercancel", end);
      // A press that did not move, such as half of a double click, leaves the height as it was.
      if (Math.abs(ended.clientY - startY) < 3) {
        setHeight(startHeight);
        return;
      }
      keep(clampHeight(startHeight + startY - ended.clientY, room));
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("pointerup", end);
    edge.addEventListener("pointercancel", end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const next = keyedHeight(event.key, height, roomHeight(event.currentTarget));
    if (next === null) return;
    event.preventDefault();
    keep(next);
  };
  return { height, expanded: restore !== null, onPointerDown, onKeyDown, toggle };
};
