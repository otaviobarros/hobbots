import { HOB_COLORS } from "@hobbots/art/look";
import type { User } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { CSSProperties } from "react";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { Face } from "./sidebar-rows.ts";

/** A person's initials on a round badge in their color. Decorative: their name is always beside it. */
export function PersonBadge({ person, size }: { person: User; size: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--person)_35%,var(--color-panel))] font-bold text-text-strong",
        size === "sm" && "size-6 text-meta",
        size === "md" && "size-7.5 text-meta",
        size === "lg" && "size-hob-tile text-meta",
      )}
      style={{ "--person": HOB_COLORS[person.color].hat } as CSSProperties}
    >
      {person.initials}
    </span>
  );
}

/** One member's face, a hob's tile or a person's badge. */
export function FaceTile({ face, size }: { face: Face; size: "sm" | "md" | "lg" }) {
  return face._tag === "hob" ? (
    <HobTile hob={face.hob} tile={size} />
  ) : (
    <PersonBadge person={face.person} size={size} />
  );
}

/** A shared camp's stack: the first face at the top left, the second over it at the bottom right. */
export function FaceStack({ faces }: { faces: ReadonlyArray<Face> }) {
  const [first, second] = faces;
  return (
    <span aria-hidden className="relative inline-block size-hob-tile flex-none">
      {first !== undefined && (
        <span className="absolute start-0 top-0 inline-flex">
          <FaceTile face={first} size="sm" />
        </span>
      )}
      {second !== undefined && (
        <span className="absolute end-0 bottom-0 inline-flex rounded-tile shadow-[0_0_0_2px_var(--color-panel)]">
          <FaceTile face={second} size="sm" />
        </span>
      )}
    </span>
  );
}
