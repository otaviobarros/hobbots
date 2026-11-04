import { HOB_COLORS } from "@hobbots/art/look";
import { lengthChoice, starterRole, voiceChoice } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import type { CSSProperties } from "react";
import { type FirstHobDraft, gearOf, roleTitleOf } from "../../api/first-hob.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { RoleSigil } from "../role-sigil.tsx";
import { messages } from "./messages.ts";

const copy = messages.preview;

// The new hob's hat color (`--hob`) tints the card and the tile live, mixed with theme tokens so it
// reads in every theme. The tile ends in a two-tone ground strip.
const cardStyle = (draft: FirstHobDraft): CSSProperties =>
  ({
    "--hob": HOB_COLORS[draft.lookColor].hat,
    backgroundImage:
      "linear-gradient(180deg, color-mix(in srgb, var(--hob) 20%, var(--color-card)) 0, var(--color-card) 62%)",
  }) as CSSProperties;

const tileStyle: CSSProperties = {
  backgroundImage:
    "linear-gradient(180deg, color-mix(in srgb, var(--hob) 30%, var(--color-deep)) 0%, color-mix(in srgb, var(--hob) 14%, var(--color-deep)) 86%, color-mix(in srgb, var(--hob) 55%, var(--color-deep)) 86%, color-mix(in srgb, var(--hob) 55%, var(--color-deep)) 90%, color-mix(in srgb, var(--hob) 38%, var(--color-deep)) 90%)",
};

/** The live preview beside Summon's steps: the sprite with its sigil, name, role, note and voice. */
export function SummonPreview({ draft, name, last }: { draft: FirstHobDraft; name: string; last: boolean }) {
  const title = roleTitleOf(draft);
  const note = draft.role === null ? copy.own : starterRole(draft.role).note;
  const sigil = draft.role ?? draft.ownSigil;
  return (
    <aside
      aria-label={copy.label}
      className="sticky top-0 flex w-[260px] flex-none flex-col items-center gap-2.5 rounded-card px-4 py-6 text-center shadow-[inset_0_0_0_1px_var(--color-line)] max-[1120px]:static max-[1120px]:w-full"
      style={cardStyle(draft)}
    >
      <span className="lbl text-label">{last ? copy.almost : copy.label}</span>
      <span className="relative grid size-32 place-items-center rounded-card" style={tileStyle}>
        <HobSprite hob={{ lookSeed: draft.lookSeed, lookColor: draft.lookColor, ...gearOf(draft) }} size={98} />
        <span
          aria-hidden
          className="absolute -bottom-2 -left-2 grid size-[34px] place-items-center rounded-control bg-tile"
        >
          <RoleSigil sigil={sigil} size={26} />
        </span>
      </span>
      <strong title={name} className="max-w-full truncate font-heading text-xl leading-[26px] font-(--heading-weight)">
        {name}
      </strong>
      {title && (
        <Badge variant="resting" title={title} className="max-w-full truncate">
          {title}
        </Badge>
      )}
      <span className="text-detail text-text-secondary">{note}</span>
      <span className="text-meta text-label">
        {copy.talks({ voice: voiceChoice(draft.voice).title, length: lengthChoice(draft.length).title })}
      </span>
    </aside>
  );
}
