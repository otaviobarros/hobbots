import type { Effort, HobColor, RuntimeModel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import {
  type BrainChoice,
  CHORES_MAX,
  CRAFTS,
  effortWords,
  type FirstHobDraft,
  LABEL_MAX,
  nearbySeeds,
  pickCraft,
  pickModel,
  thinksWith,
} from "../api/first-hob.ts";
import { HOB_COLORS } from "../art/look.ts";
import { HobSprite } from "./hob-sprite.tsx";

/**
 * The hob fields that onboarding's first hob and Summon share: chores, craft, name dice, colors,
 * nearby looks, the model and effort a hob thinks with, and the line that sums it up. Each screen
 * lays them out its own way, but both offer the same choices.
 */

const DIE = ["owwwo", "wwwww", "wwoww", "wwwww", "owwwo"];
const DIE_PALETTE = { o: "#141228", w: "#ece8ff" };

/** A die that turns a quarter at a time each time it is rolled. */
export function Die({ size, rolls }: { size: number; rolls: number }) {
  return (
    <span key={rolls} className={cn("block", rolls > 0 && "animate-hb-roll")}>
      <PixelArt rows={DIE} palette={DIE_PALETTE} size={size} />
    </span>
  );
}

/** The dice button next to a name field. */
export function NameDice({
  rolls,
  onRoll,
  size,
  className,
}: {
  rolls: number;
  onRoll: () => void;
  /** The die's own size; the button grows around it. */
  size: number;
  className?: string | undefined;
}) {
  return (
    <Button
      type="button"
      variant="icon"
      onClick={onRoll}
      aria-label="Random name"
      title="Random name"
      className={cn("cut border-control bg-line hover:bg-line-2", className)}
    >
      <Die size={size} rolls={rolls} />
    </Button>
  );
}

/** A focus ring drawn inside the pixel corners, which would clip one drawn outside. */
export const focusWithin =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-4";

/**
 * One option of a radio group, drawn as a chip. A native radio underneath gives arrow keys,
 * Space and screen readers the group's real behavior.
 */
export function Choice({
  name,
  checked,
  onPick,
  label,
  className,
  children,
}: {
  name: string;
  checked: boolean;
  onPick: () => void;
  label?: string | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "cut flex cursor-pointer items-center gap-2 border-2 px-3 py-[7px] text-sm",
        checked ? "border-lantern bg-lantern text-ground" : "border-control text-text hover:bg-line",
        focusWithin,
        className,
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onPick} aria-label={label} className="sr-only" />
      {children}
    </label>
  );
}

/** The chores in the user's own words, filled in from the craft until they write their own. */
export function ChoresField<D extends FirstHobDraft>({
  draft,
  onChange,
  label,
  rows,
  className,
}: {
  draft: D;
  onChange: (update: (draft: D) => D) => void;
  label: React.ReactNode;
  rows: number;
  className?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="hob-chores" className={className}>
        {label}
      </label>
      <textarea
        id="hob-chores"
        rows={rows}
        value={draft.chores}
        maxLength={CHORES_MAX}
        onChange={(e) => {
          const chores = e.target.value;
          onChange((d) => ({ ...d, chores, choresEdited: true }));
        }}
        aria-describedby="hob-chores-note"
        placeholder="Tell it about the chores, like you would tell a friend who is helping out."
        className="resize-none border-2 border-control bg-deep px-3 py-2.5 leading-normal text-text placeholder:text-label"
      />
      <span id="hob-chores-note" className="text-[13px] text-label">
        {draft.choresEdited
          ? "In your words. Hobbots adds them to the hob's instructions."
          : "Filled in from the craft. Write it in your own words."}
      </span>
    </div>
  );
}

/** The crafts to pick from, with a field for the user's own when they pick "Your own". */
export function CraftChoices<D extends FirstHobDraft>({
  draft,
  onChange,
  legend,
  showNote = false,
}: {
  draft: D;
  onChange: (update: (draft: D) => D) => void;
  legend: React.ReactNode;
  /** Shows what the picked craft is good at under the chips, for a screen without that line elsewhere. */
  showNote?: boolean;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      {legend}
      <div className="flex flex-wrap gap-2">
        {CRAFTS.map((c) => (
          <Choice
            key={c.kind}
            name="hob-craft"
            checked={draft.kind === c.kind}
            onPick={() => onChange((d) => pickCraft(d, c.kind))}
            className={c.kind === "custom" && draft.kind !== "custom" ? "border-dashed" : undefined}
          >
            {c.kind === "custom" ? `+ ${c.label}` : c.label}
          </Choice>
        ))}
      </div>
      {draft.kind === "custom" && (
        <input
          // biome-ignore lint/a11y/noAutofocus: choosing "Your own" asks for the craft right away.
          autoFocus
          value={draft.craft}
          maxLength={LABEL_MAX}
          onChange={(e) => {
            const craft = e.target.value;
            onChange((d) => ({ ...d, craft }));
          }}
          placeholder="What should it be good at? e.g. planning my garden"
          aria-label="Your own craft"
          className="animate-hb-in border-2 border-lantern bg-deep px-[11px] py-[9px] text-[15px] text-text"
        />
      )}
      {showNote && <span className="text-[13px] text-label">{CRAFTS.find((c) => c.kind === draft.kind)?.note}</span>}
    </fieldset>
  );
}

/** The hob colors as swatches, each with its hat over its coat. */
export function ColorSwatches({
  value,
  onPick,
  className,
}: {
  value: HobColor;
  onPick: (color: HobColor) => void;
  className?: string | undefined;
}) {
  return (
    <div className={className}>
      {(Object.keys(HOB_COLORS) as Array<HobColor>).map((id) => {
        const color = HOB_COLORS[id];
        const on = value === id;
        return (
          <label
            key={id}
            title={color.label}
            className={cn(
              "size-8 cursor-pointer border-[3px]",
              on ? "border-moonlight" : "border-line",
              "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight",
            )}
            style={{ background: color.hat, boxShadow: `inset 0 -11px 0 ${color.coat}` }}
          >
            <input
              type="radio"
              name="hob-color"
              checked={on}
              onChange={() => onPick(id)}
              aria-label={color.label}
              className="sr-only"
            />
          </label>
        );
      })}
    </div>
  );
}

/** Other looks near the current one, for "More like this"; picking one keeps the set. */
export function NearbyLooks({
  draft,
  onPick,
  count = 5,
  tile,
  className,
}: {
  draft: FirstHobDraft;
  onPick: (seed: number) => void;
  count?: number;
  /** The tile's size; the hob inside it is eight pixels smaller. */
  tile: number;
  className?: string | undefined;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="lbl mb-1.5 text-xs text-label">More like this</legend>
      <div className={className}>
        {nearbySeeds(draft.lookBase)
          .slice(0, count)
          .map((seed) => (
            <label
              key={seed}
              className={cn(
                "hop-on-hover grid cursor-pointer place-items-center border-2 bg-line hover:border-moonlight",
                seed === draft.lookSeed ? "border-moonlight" : "border-line-2",
                "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight",
              )}
              style={{ width: tile, height: tile }}
            >
              <input
                type="radio"
                name="hob-look"
                checked={seed === draft.lookSeed}
                onChange={() => onPick(seed)}
                aria-label={`Look ${seed}`}
                className="sr-only"
              />
              <HobSprite hob={{ lookSeed: seed, lookColor: draft.lookColor }} size={tile - 8} />
            </label>
          ))}
      </div>
    </fieldset>
  );
}

/** The line that sums up how the hob thinks and what its craft is good at. */
export function HobSummary({
  draft,
  model,
  className,
}: {
  draft: FirstHobDraft;
  model: RuntimeModel | undefined;
  className?: string | undefined;
}) {
  const note = CRAFTS.find((c) => c.kind === draft.kind)?.note;
  return (
    <div className={cn("flex flex-col gap-[3px] text-[13px] text-secondary-text", className)}>
      <span>
        Thinks with <b className="text-text">{thinksWith(draft, model)}</b>
      </span>
      {note && <span>{note}</span>}
    </div>
  );
}

function EffortBars({ index, count, on }: { index: number; count: number; on: boolean }) {
  return (
    <span aria-hidden className="flex items-end gap-0.5">
      {Array.from({ length: count }, (_, j) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed row of identical marks.
          key={j}
          className="w-[3px]"
          style={{
            height: 4 + j * 3,
            background: j <= index ? (on ? "#141228" : "#ece8ff") : on ? "rgba(20,18,40,.25)" : "#3a3666",
          }}
        />
      ))}
    </span>
  );
}

/**
 * The model and effort a hob thinks with, with what each model is for and what the effort costs.
 * The hob profile edits an existing hob's brain with it too.
 */
export function Brain<D extends BrainChoice>({
  models,
  draft,
  onChange,
}: {
  models: ReadonlyArray<RuntimeModel>;
  draft: D;
  onChange: (draft: D) => void;
}) {
  const model = models.find((m) => m.id === draft.model);
  const efforts = model?.efforts ?? [];
  return (
    <>
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Model</legend>
        {models.map((m) => (
          <Choice
            key={m.id}
            name="hob-model"
            checked={m.id === draft.model}
            onPick={() => onChange(pickModel(draft, m))}
            className="flex-col items-start gap-px py-[5px]"
          >
            <span className="font-bold">{m.displayName}</span>
            <span className="max-w-[220px] text-xs opacity-85">{m.description}</span>
          </Choice>
        ))}
      </fieldset>
      {efforts.length > 0 ? (
        <fieldset className="m-0 flex flex-wrap items-center gap-3 border-0 p-0">
          <legend className="sr-only">Effort</legend>
          {/* A legend cannot sit inline with the row, so the visible label is a plain span. */}
          <span aria-hidden className="text-sm font-bold">
            Effort
          </span>
          <div className="flex flex-wrap border-2 border-control">
            {efforts.map((effort: Effort, i) => {
              const on = effort === draft.effort;
              return (
                <label
                  key={effort}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 px-[11px] py-1.5 text-sm whitespace-nowrap",
                    on ? "bg-lantern text-ground" : "text-text hover:bg-line",
                    "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-3",
                  )}
                >
                  <input
                    type="radio"
                    name="hob-effort"
                    checked={on}
                    onChange={() => onChange({ ...draft, effort })}
                    className="sr-only"
                  />
                  <EffortBars index={i} count={efforts.length} on={on} />
                  {effortWords(effort).label}
                </label>
              );
            })}
          </div>
          {draft.effort && (
            <span key={draft.effort} className="animate-hb-in text-[13px] text-secondary-text">
              {effortWords(draft.effort).note}
            </span>
          )}
        </fieldset>
      ) : (
        model && <span className="text-[13px] text-label">{model.displayName} takes no effort setting.</span>
      )}
    </>
  );
}
