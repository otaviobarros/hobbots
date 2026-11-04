import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import type { DockSource } from "./dock-model.ts";
import { messages } from "./messages.ts";

/** Whether the dock's list holds more than one hob's work, so each row shows whose it is. */
export const manyHobs = (sources: ReadonlyArray<DockSource>): boolean =>
  new Set(sources.map((each) => each.ownerId)).size > 1;

/** The sprite of the hob a row's work is for, at the row's start, its name in the hint. */
export function HobMark({ hob }: { hob: ReturnType<HobLookup> }) {
  return (
    <span title={hob.name} className="flex">
      <HobTile hob={hob} tile="sm" />
    </span>
  );
}

/** Whose work a row is, at the end of its name for a screen reader, as the sprite says it on screen. */
export function HobBy({ hob }: { hob: ReturnType<HobLookup> }) {
  return <span className="sr-only">{messages.dock.by({ name: hob.name })}</span>;
}
