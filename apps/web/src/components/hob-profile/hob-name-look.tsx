import { HOB_COLORS } from "@hobbots/art/look";
import { type HobColor, ROLE_HAT_TITLES, ROLE_TOOL_TITLES, type RoleHat, type RoleTool } from "@hobbots/domain";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { cn } from "@hobbots/ui/lib/utils";
import { useId, useState } from "react";
import { nearbySeeds } from "../../api/first-hob.ts";
import { NAME_MAX, type ProfileDraft } from "../../api/profile.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";

const HATS = Object.keys(ROLE_HAT_TITLES) as Array<RoleHat>;
const TOOLS = Object.keys(ROLE_TOOL_TITLES) as Array<RoleTool>;
const COLORS = Object.keys(HOB_COLORS) as Array<HobColor>;
// The chip that leaves the hat or the tool to the look seed.
const FROM_LOOK = "look";

/**
 * The hob's name, look, color, hat and tool, folded away until the user opens it. The looks on
 * offer are the one the hob had when the profile opened and four near it, so picking one never
 * loses the way back.
 */
export function NameAndLook({
  name,
  draft,
  disabled,
  onChange,
}: {
  /** The hob's saved name, for the copy. */
  name: string;
  draft: ProfileDraft;
  disabled: boolean;
  onChange: (update: (draft: ProfileDraft) => ProfileDraft) => void;
}) {
  const copy = messages.profile.look;
  const [open, setOpen] = useState(false);
  const [looks] = useState(() => [draft.lookSeed, ...nearbySeeds(draft.lookSeed).slice(0, 4)]);
  const headingId = useId();
  const panelId = useId();
  const gear = { hat: draft.hat, tool: draft.tool };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 rounded-card bg-card p-4">
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="lbl m-0 flex-1 text-label">
          {copy.heading}
        </h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="cursor-pointer rounded-control border-0 bg-transparent px-1.5 py-0.5 text-detail text-link hover:bg-hover hover:text-text-strong"
        >
          {open ? copy.done : copy.change}
        </button>
      </div>
      {open && (
        <fieldset id={panelId} disabled={disabled} className="m-0 flex animate-hb-in flex-col gap-2.5 border-0 p-0">
          <input
            aria-label={copy.name}
            value={draft.name}
            maxLength={NAME_MAX}
            onChange={(e) => {
              const next = e.target.value;
              onChange((d) => ({ ...d, name: next }));
            }}
            className="rounded-control border-(length:--edge) border-control bg-deep px-2.5 py-2 text-text-strong"
          />

          <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
            <legend className="sr-only">{copy.lookGroup}</legend>
            {looks.map((seed, i) => {
              const on = seed === draft.lookSeed;
              return (
                <label
                  key={seed}
                  className={cn(
                    "hop-on-hover grid size-14 cursor-pointer place-items-center rounded-control bg-deep p-1.5",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring",
                    on && "shadow-[inset_0_0_0_2px_var(--color-focus-ring)]",
                  )}
                >
                  <input
                    type="radio"
                    name={`${panelId}-look`}
                    checked={on}
                    onChange={() => onChange((d) => ({ ...d, lookSeed: seed }))}
                    aria-label={copy.lookOption({ index: i + 1 })}
                    className="sr-only"
                  />
                  <HobSprite hob={{ lookSeed: seed, lookColor: draft.lookColor, ...gear }} size={40} />
                </label>
              );
            })}
          </fieldset>

          <fieldset className="m-0 flex flex-wrap gap-2.5 border-0 p-0">
            <legend className="sr-only">{copy.colorGroup}</legend>
            {COLORS.map((id) => {
              const on = id === draft.lookColor;
              return (
                <label
                  key={id}
                  title={HOB_COLORS[id].label}
                  className={cn(
                    "size-5.5 cursor-pointer rounded-dot",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-focus-ring",
                    on && "shadow-[0_0_0_2px_var(--color-ground),0_0_0_4px_var(--color-focus-ring)]",
                  )}
                  style={{ background: HOB_COLORS[id].hat }}
                >
                  <input
                    type="radio"
                    name={`${panelId}-color`}
                    checked={on}
                    onChange={() => onChange((d) => ({ ...d, lookColor: id }))}
                    aria-label={HOB_COLORS[id].label}
                    className="sr-only"
                  />
                </label>
              );
            })}
          </fieldset>

          <GearChips
            label={copy.hat}
            value={draft.hat}
            options={HATS.map((hat) => [hat, ROLE_HAT_TITLES[hat]] as const)}
            onPick={(hat) => onChange((d) => ({ ...d, hat }))}
          />
          <GearChips
            label={copy.tool}
            value={draft.tool}
            options={TOOLS.map((tool) => [tool, ROLE_TOOL_TITLES[tool]] as const)}
            onPick={(tool) => onChange((d) => ({ ...d, tool }))}
          />

          <p className="m-0 text-detail text-label">{copy.note({ name })}</p>
        </fieldset>
      )}
    </section>
  );
}

/** One chip per hat or tool, after the chip that leaves it to the look seed. */
function GearChips<Gear extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: Gear | null;
  options: ReadonlyArray<readonly [Gear, string]>;
  onPick: (gear: Gear | null) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="lbl text-label">
        {label}
      </span>
      <FilterChips
        aria-labelledby={labelId}
        value={value ?? FROM_LOOK}
        onValueChange={(next) => onPick(next === FROM_LOOK ? null : (next as Gear))}
      >
        <FilterChip value={FROM_LOOK} className="h-6.5 px-2.5 text-detail">
          {messages.profile.look.fromLook}
        </FilterChip>
        {options.map(([id, title]) => (
          <FilterChip key={id} value={id} className="h-6.5 px-2.5 text-detail">
            {title}
          </FilterChip>
        ))}
      </FilterChips>
    </div>
  );
}
