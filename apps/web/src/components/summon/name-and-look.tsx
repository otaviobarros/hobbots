import { HOB_COLORS } from "@hobbots/art/look";
import type { HobColor } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useId, useState } from "react";
import { type FirstHobDraft, gearOf, LABEL_MAX, pickLook, rerollName } from "../../api/first-hob.ts";
import { Die, FIELD } from "../hob-form/hob-form.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";
import { PickCard } from "./pick.tsx";
import { lookChoices } from "./summon-model.ts";

/**
 * The name and look pieces that Summon's second step and First run's First hob share: the name with
 * Roll a name, five looks and the six hob colors.
 */

const copy = messages.look;

type Update = (update: (draft: FirstHobDraft) => FirstHobDraft) => void;

const COLORS = Object.keys(HOB_COLORS) as ReadonlyArray<HobColor>;

/** The name field with Roll a name beside it. Summon's second step and First run's First hob share it. */
export function NameField({ draft, onChange }: { draft: FirstHobDraft; onChange: Update }) {
  const [rolls, setRolls] = useState(0);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="lbl text-label">{copy.name}</span>
      <span className="flex gap-2">
        <input
          value={draft.name}
          maxLength={LABEL_MAX}
          onChange={(e) => {
            const value = e.target.value;
            onChange((d) => ({ ...d, name: value, named: true }));
          }}
          aria-label={copy.nameLabel}
          className={`min-w-0 flex-1 text-[17px] ${FIELD}`}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onChange(rerollName);
            setRolls((n) => n + 1);
          }}
        >
          <Die size={16} rolls={rolls} />
          {copy.rollName}
        </Button>
      </span>
    </label>
  );
}

/** Five looks to pick from, and Surprise me when the caller offers it. */
export function Looks({
  draft,
  onChange,
  onSurprise,
  rolls = 0,
}: {
  draft: FirstHobDraft;
  onChange: Update;
  onSurprise?: (() => void) | undefined;
  rolls?: number;
}) {
  const radios = useId();
  return (
    <fieldset className="m-0 flex flex-wrap items-center gap-2.5 border-0 p-0">
      <legend className="sr-only">{copy.look}</legend>
      {lookChoices(draft).map((seed, i) => (
        <PickCard
          key={seed}
          name={radios}
          checked={draft.lookSeed === seed}
          onPick={() => onChange((d) => pickLook(d, seed))}
          label={copy.lookN({ n: i + 1 })}
          className="hop-on-hover size-16 items-center justify-center p-2"
        >
          <HobSprite hob={{ lookSeed: seed, lookColor: draft.lookColor, ...gearOf(draft) }} size={44} />
        </PickCard>
      ))}
      {onSurprise && (
        <Button type="button" variant="ghost" onClick={onSurprise}>
          <Die size={16} rolls={rolls} />
          {copy.surprise}
        </Button>
      )}
    </fieldset>
  );
}

/** The six hob colors as round swatches. */
export function Colors({ value, onPick }: { value: HobColor; onPick: (color: HobColor) => void }) {
  const radios = useId();
  return (
    <fieldset className="m-0 flex flex-wrap gap-2.5 border-0 pt-1 p-0">
      <legend className="sr-only">{copy.color}</legend>
      {COLORS.map((id) => (
        <label
          key={id}
          title={HOB_COLORS[id].label}
          className="size-[26px] cursor-pointer rounded-dot has-checked:shadow-[0_0_0_2px_var(--color-ground),0_0_0_4px_var(--color-focus-ring)] has-focus-visible:outline-2 has-focus-visible:outline-offset-4 has-focus-visible:outline-focus-ring"
          style={{ background: HOB_COLORS[id].hat }}
        >
          <input
            type="radio"
            name={radios}
            checked={value === id}
            onChange={() => onPick(id)}
            aria-label={HOB_COLORS[id].label}
            className="sr-only"
          />
        </label>
      ))}
    </fieldset>
  );
}
