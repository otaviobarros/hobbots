import type { Agent } from "@hobbots/domain";
import { DropdownMenuItem } from "@hobbots/ui/components/menu";
import { HobSprite } from "./hob-sprite.tsx";

/** Hobs as a menu's items, each with its sprite, picked with `onPick`. */
export function HobMenuItems({ hobs, onPick }: { hobs: ReadonlyArray<Agent>; onPick: (hob: Agent) => void }) {
  return hobs.map((hob) => (
    <DropdownMenuItem key={hob.id} inset onSelect={() => onPick(hob)}>
      <HobSprite hob={hob} size={16} />
      {hob.name}
    </DropdownMenuItem>
  ));
}
