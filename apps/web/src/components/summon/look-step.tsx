import { HOB_COLORS } from "@hobbots/art/look";
import {
  type HobColor,
  REPLY_LENGTHS,
  type ReplyLength,
  ROLE_HAT_TITLES,
  ROLE_TOOL_TITLES,
  type RoleHat,
  type RoleTool,
  VOICES,
  voiceChoice,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useId, useState } from "react";
import { type FirstHobDraft, gearOf, LABEL_MAX, pickLook, rerollName, rollLook } from "../../api/first-hob.ts";
import { Die, FIELD } from "../hob-form/hob-form.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";
import { PickCard, PickChip } from "./pick.tsx";
import { gearHint, lookChoices } from "./summon-model.ts";

const copy = messages.look;

type Update = (update: (draft: FirstHobDraft) => FirstHobDraft) => void;

const HATS = Object.keys(ROLE_HAT_TITLES) as ReadonlyArray<RoleHat>;
const TOOLS = Object.keys(ROLE_TOOL_TITLES) as ReadonlyArray<RoleTool>;
const COLORS = Object.keys(HOB_COLORS) as ReadonlyArray<HobColor>;
const EVERYDAY = VOICES.filter((v) => v.group === "everyday");
const OTHER_VOICES = VOICES.filter((v) => v.group !== "everyday");

/** Step 2, name and look: the name with dice, five looks, six colors, the hat and tool, then how it talks. */
export function LookStep({ draft, onChange, name }: { draft: FirstHobDraft; onChange: Update; name: string }) {
  const [nameRolls, setNameRolls] = useState(0);
  const [lookRolls, setLookRolls] = useState(0);
  return (
    <div className="flex flex-col gap-5">
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
              setNameRolls((n) => n + 1);
            }}
          >
            <Die size={16} rolls={nameRolls} />
            {copy.rollName}
          </Button>
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <span aria-hidden className="lbl text-label">
          {copy.look}
        </span>
        <Looks
          draft={draft}
          onChange={onChange}
          onSurprise={() => {
            onChange((d) => rollLook(d));
            setLookRolls((n) => n + 1);
          }}
          rolls={lookRolls}
        />
        <Colors value={draft.lookColor} onPick={(lookColor) => onChange((d) => ({ ...d, lookColor }))} />
        <ChipGroup
          legend={copy.hat}
          options={HATS.map((hat) => ({ id: hat, title: ROLE_HAT_TITLES[hat] }))}
          value={draft.hat}
          onPick={(hat) => onChange((d) => ({ ...d, hat }))}
        />
        <ChipGroup
          legend={copy.tool}
          options={TOOLS.map((tool) => ({ id: tool, title: ROLE_TOOL_TITLES[tool] }))}
          value={draft.tool}
          onPick={(tool) => onChange((d) => ({ ...d, tool }))}
        />
        <span className="text-detail text-label">{gearHint(draft)}</span>
      </div>

      <Talk draft={draft} onChange={onChange} name={name} />
    </div>
  );
}

function Looks({
  draft,
  onChange,
  onSurprise,
  rolls,
}: {
  draft: FirstHobDraft;
  onChange: Update;
  onSurprise: () => void;
  rolls: number;
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
      <Button type="button" variant="ghost" onClick={onSurprise} className="text-text-secondary">
        <Die size={16} rolls={rolls} />
        {copy.surprise}
      </Button>
    </fieldset>
  );
}

function Colors({ value, onPick }: { value: HobColor; onPick: (color: HobColor) => void }) {
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

/** A row of chips for the hat or the tool; "From the look" leaves it to the dice. */
function ChipGroup<Id extends string>({
  legend,
  options,
  value,
  onPick,
}: {
  legend: string;
  options: ReadonlyArray<{ id: Id; title: string }>;
  value: Id | null;
  onPick: (id: Id | null) => void;
}) {
  const radios = useId();
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 pt-1.5 p-0">
      <legend className="lbl mb-1.5 text-label">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        <PickChip name={radios} checked={value === null} onPick={() => onPick(null)}>
          {copy.fromLook}
        </PickChip>
        {options.map((option) => (
          <PickChip key={option.id} name={radios} checked={value === option.id} onPick={() => onPick(option.id)}>
            {option.title}
          </PickChip>
        ))}
      </div>
    </fieldset>
  );
}

/** How it talks: the five everyday voices, the rest behind More voices, and the reply length. */
function Talk({ draft, onChange, name }: { draft: FirstHobDraft; onChange: Update; name: string }) {
  const radios = useId();
  const other = OTHER_VOICES.some((v) => v.id === draft.voice);
  const voice = (choice: (typeof VOICES)[number]) => (
    <PickCard
      key={choice.id}
      name={radios}
      checked={draft.voice === choice.id}
      onPick={() => onChange((d) => ({ ...d, voice: choice.id }))}
      className="flex-col gap-0.5 p-2"
    >
      <strong className="text-ui">{choice.title}</strong>
      <span className="text-meta text-text-secondary">{choice.description}</span>
    </PickCard>
  );
  return (
    <div className="flex flex-col gap-2">
      <span aria-hidden className="lbl text-label">
        {copy.talks}
      </span>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{copy.voice}</legend>
        <div className="grid grid-cols-5 gap-2 max-[900px]:grid-cols-3">{EVERYDAY.map(voice)}</div>
        <details open={other || undefined} className="flex flex-col gap-2">
          <summary className="cursor-pointer text-detail text-link">{copy.moreVoices}</summary>
          <div className="mt-2 grid grid-cols-5 gap-2 max-[900px]:grid-cols-3">{OTHER_VOICES.map(voice)}</div>
        </details>
      </fieldset>
      {voiceChoice(draft.voice).group === "themed" && (
        <span className="text-detail text-label">{copy.themedNote({ name })}</span>
      )}
      <SegmentedControl<ReplyLength>
        aria-label={copy.length}
        value={draft.length}
        onValueChange={(length) => onChange((d) => ({ ...d, length }))}
        className="w-80"
      >
        {REPLY_LENGTHS.map((length) => (
          <SegmentedControlItem key={length.id} value={length.id} className="flex-1">
            {length.title}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <div className="flex items-start gap-2.5 rounded-card bg-deep px-3 py-2.5">
        <span className="lbl flex-none text-label">{copy.soundsLike}</span>
        <span aria-live="polite" className="text-ui text-text">
          {copy.samples[draft.voice]}
        </span>
      </div>
    </div>
  );
}
