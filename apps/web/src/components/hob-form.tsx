import type { Effort, HobColor, RuntimeModel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { CRAFTS, effortWords, type FirstHobDraft, LABEL_MAX, pickCraft, pickModel } from "../api/first-hob.ts";
import { HOB_COLORS } from "../art/look.ts";

/**
 * The pieces of the hob form that onboarding's first hob and Summon share: craft, name dice,
 * colors, and the model and effort a hob thinks with.
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

/** The crafts to pick from, with a field for the user's own when they pick "Your own". */
export function CraftChoices<D extends FirstHobDraft>({
  draft,
  onChange,
  legend,
}: {
  draft: D;
  onChange: (update: (draft: D) => D) => void;
  legend: React.ReactNode;
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
    </fieldset>
  );
}

/** The hob colors as swatches: hat over coat, or just the hat when small. */
export function ColorSwatches({
  value,
  onPick,
  size,
  className,
}: {
  value: HobColor;
  onPick: (color: HobColor) => void;
  size: "small" | "large";
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
              "cursor-pointer border-[3px]",
              size === "large" ? "size-8" : "size-[22px]",
              on ? "border-moonlight" : size === "large" ? "border-line" : "border-panel",
              "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight",
            )}
            style={{
              background: color.hat,
              boxShadow: size === "large" ? `inset 0 -11px 0 ${color.coat}` : undefined,
            }}
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
 * The model and effort a hob thinks with. Compact drops the model descriptions and the effort
 * note, for the narrower Summon card.
 */
export function Brain<D extends FirstHobDraft>({
  models,
  draft,
  onChange,
  compact = false,
}: {
  models: ReadonlyArray<RuntimeModel>;
  draft: D;
  onChange: (draft: D) => void;
  compact?: boolean;
}) {
  const model = models.find((m) => m.id === draft.model);
  const efforts = model?.efforts ?? [];
  return (
    <>
      <fieldset className={cn("m-0 flex flex-wrap border-0 p-0", compact ? "gap-1.5" : "gap-2")}>
        <legend className="sr-only">Model</legend>
        {models.map((m) => (
          <Choice
            key={m.id}
            name="hob-model"
            checked={m.id === draft.model}
            onPick={() => onChange(pickModel(draft, m))}
            className={compact ? "px-[9px] py-[3px] text-[13px]" : "flex-col items-start gap-px py-[5px]"}
          >
            {compact ? (
              <span title={m.description}>{m.displayName}</span>
            ) : (
              <>
                <span className="font-bold">{m.displayName}</span>
                <span className="max-w-[220px] text-xs opacity-85">{m.description}</span>
              </>
            )}
          </Choice>
        ))}
      </fieldset>
      {efforts.length > 0 ? (
        <fieldset className={cn("m-0 flex flex-wrap items-center border-0 p-0", compact ? "gap-2" : "gap-3")}>
          <legend className="sr-only">Effort</legend>
          {/* A legend cannot sit inline with the row, so the visible label is a plain span. */}
          <span aria-hidden className={compact ? "text-xs text-label" : "text-sm font-bold"}>
            Effort
          </span>
          <div className="flex border-2 border-control">
            {efforts.map((effort: Effort, i) => {
              const on = effort === draft.effort;
              return (
                <label
                  key={effort}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5",
                    compact ? "px-2 py-[3px] text-xs whitespace-nowrap" : "px-[11px] py-1.5 text-sm",
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
          {draft.effort && !compact && (
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
