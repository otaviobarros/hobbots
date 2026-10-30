import {
  type Effort,
  type HobColor,
  PICKER_FIRST,
  ROLE_HAT_TITLES,
  ROLE_TOOL_TITLES,
  type RoleHat,
  type RoleId,
  type RoleTool,
  type RuntimeModel,
  starterRole,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { Sigil } from "@hobbots/ui/components/sigil";
import { cn } from "@hobbots/ui/lib/utils";
import { useId, useState } from "react";
import {
  ALL_ROLES,
  type BrainChoice,
  CHORES_MAX,
  effortWords,
  type FirstHobDraft,
  gearOf,
  LABEL_MAX,
  MORE_ROLES,
  nearbySeeds,
  pickModel,
  pickRole,
  roleRequestUrl,
  splitModels,
  thinksWith,
} from "../api/first-hob.ts";
import { HOB_COLORS } from "../art/look.ts";
import { HobSprite } from "./hob-sprite.tsx";

/**
 * The hob fields that onboarding's first hob and Summon share: chores, role, name dice, colors,
 * hat and tool, nearby looks, the model and effort a hob thinks with, and the line that sums it up. Each screen
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

/** The chores in the user's own words, filled in from the role until they write their own. */
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
          : draft.role === null
            ? "Tell it about the chores in your own words."
            : "Filled in from the role. Write it in your own words."}
      </span>
    </div>
  );
}

/** One role in the picker: its sigil, title and one-line note, over a native radio. */
function RoleOption({
  checked,
  onPick,
  sigil,
  title,
  note,
  className,
}: {
  checked: boolean;
  onPick: () => void;
  sigil: ReadonlyArray<string> | null;
  title: string;
  note: string;
  className?: string | undefined;
}) {
  return (
    <label
      className={cn(
        "cut flex min-w-0 cursor-pointer items-start gap-2.5 border-2 px-2.5 py-2 text-left",
        checked ? "border-lantern bg-line" : "border-line hover:bg-hover",
        focusWithin,
        className,
      )}
    >
      <input type="radio" name="hob-role" checked={checked} onChange={onPick} className="sr-only" />
      {sigil ? (
        <Sigil rows={sigil} size={20} className="mt-0.5 flex-none" />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 grid size-5 flex-none place-items-center border-2 border-dashed border-control text-xs text-label"
        >
          +
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-sm font-bold", checked ? "text-moonlight" : "text-text")}>{title}</span>
        <span className="text-xs leading-snug text-secondary-text">{note}</span>
      </span>
    </label>
  );
}

const roleOption = (id: RoleId) => {
  const role = starterRole(id);
  return { sigil: role.sigil, title: role.title, note: role.note };
};

/**
 * The role picker: the first eight roles, then "More roles" under their families, then "Your own",
 * which takes a title in the user's words and any sigil from the set. One radio group runs through
 * all of them, so arrow keys move from role to role. A link at the end asks for a missing role.
 */
export function RolePicker<D extends FirstHobDraft>({
  draft,
  onChange,
  legend,
  columns = 3,
}: {
  draft: D;
  onChange: (update: (draft: D) => D) => void;
  legend: React.ReactNode;
  /** How many roles sit side by side; the screen picks what fits. */
  columns?: 2 | 3;
}) {
  const inMore = draft.role !== null && !PICKER_FIRST.includes(draft.role);
  // "More roles" starts open when the hob already has one of them, so the choice stays in view.
  const [moreShown, setMoreShown] = useState<boolean | null>(null);
  const moreOpen = moreShown ?? inMore;
  const moreId = useId();
  const own = draft.role === null;
  const grid = columns === 3 ? "grid-cols-3" : "grid-cols-2";
  const moreCount = MORE_ROLES.reduce((n, group) => n + group.roles.length, 0);
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      {legend}
      <div className={cn("grid gap-1.5", grid)}>
        {PICKER_FIRST.map((id) => (
          <RoleOption
            key={id}
            checked={draft.role === id}
            onPick={() => onChange((d) => pickRole(d, id))}
            {...roleOption(id)}
          />
        ))}
      </div>
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-controls={moreId}
        onClick={() => setMoreShown(!moreOpen)}
        className="flex items-center gap-2 self-start bg-transparent py-1 text-sm text-label hover:text-text"
      >
        <span aria-hidden className="w-2.5">
          {moreOpen ? "▾" : "▸"}
        </span>
        More roles
        <span className="text-[13px]">{moreCount}</span>
      </button>
      {moreOpen && (
        <div id={moreId} className="flex animate-hb-in flex-col gap-3 border-2 border-line p-2.5">
          {MORE_ROLES.map((group) => (
            <fieldset key={group.family} className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className="lbl mb-1.5 text-xs text-label">{group.title}</legend>
              <div className={cn("grid gap-1.5", grid)}>
                {group.roles.map((id) => (
                  <RoleOption
                    key={id}
                    checked={draft.role === id}
                    onPick={() => onChange((d) => pickRole(d, id))}
                    {...roleOption(id)}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
      <RoleOption
        checked={own}
        onPick={() => onChange((d) => pickRole(d, null))}
        sigil={own ? starterRole(draft.ownSigil).sigil : null}
        title="Your own"
        note="Give it a title in your words and pick a sigil."
        className={cn("self-start", !own && "border-dashed")}
      />
      {own && <OwnRole draft={draft} onChange={onChange} />}
      <a href={roleRequestUrl(draft)} target="_blank" rel="noreferrer" className="self-start text-[13px]">
        Missing a role? Suggest one
      </a>
    </fieldset>
  );
}

/** A role title in the user's own words, with a sigil borrowed from any starter role. */
function OwnRole<D extends FirstHobDraft>({
  draft,
  onChange,
}: {
  draft: D;
  onChange: (update: (draft: D) => D) => void;
}) {
  return (
    <div className="flex animate-hb-in flex-col gap-2.5 border-2 border-line p-2.5">
      <input
        // biome-ignore lint/a11y/noAutofocus: choosing "Your own" asks for the title right away.
        autoFocus
        value={draft.ownTitle}
        maxLength={LABEL_MAX}
        onChange={(e) => {
          const ownTitle = e.target.value;
          onChange((d) => ({ ...d, ownTitle }));
        }}
        placeholder="Its role, in your words. e.g. Garden planner"
        aria-label="Your own role title"
        className="border-2 border-lantern bg-deep px-[11px] py-[9px] text-[15px] text-text"
      />
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 text-[13px] text-secondary-text">Sigil</legend>
        <div className="flex flex-wrap gap-1">
          {ALL_ROLES.map((id) => {
            const on = draft.ownSigil === id;
            return (
              <label
                key={id}
                title={starterRole(id).title}
                className={cn(
                  "grid size-8 cursor-pointer place-items-center border-2 bg-deep",
                  on ? "border-lantern" : "border-line hover:border-control",
                  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight",
                )}
              >
                <input
                  type="radio"
                  name="hob-sigil"
                  checked={on}
                  onChange={() => onChange((d) => ({ ...d, ownSigil: id }))}
                  aria-label={`${starterRole(id).title}'s sigil`}
                  className="sr-only"
                />
                <Sigil rows={starterRole(id).sigil} size={20} />
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

const HATS = Object.keys(ROLE_HAT_TITLES) as Array<RoleHat>;
const TOOLS = Object.keys(ROLE_TOOL_TITLES) as Array<RoleTool>;

/**
 * The hat and tool next to the look. Picking a role sets both; the user can still change either,
 * or leave it to the look seed.
 */
export function GearPicker<D extends FirstHobDraft>({
  draft,
  onChange,
  className,
}: {
  draft: D;
  onChange: (update: (draft: D) => D) => void;
  className?: string | undefined;
}) {
  const select = "min-w-0 flex-1 border-2 border-control bg-deep px-2 py-1 text-[13px] text-text";
  return (
    <div className={cn("flex gap-2", className)}>
      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-label">
        Hat
        <select
          value={draft.hat ?? ""}
          onChange={(e) => {
            const hat = (e.target.value || null) as RoleHat | null;
            onChange((d) => ({ ...d, hat }));
          }}
          className={select}
        >
          <option value="">From the look</option>
          {HATS.map((hat) => (
            <option key={hat} value={hat}>
              {ROLE_HAT_TITLES[hat]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-label">
        Tool
        <select
          value={draft.tool ?? ""}
          onChange={(e) => {
            const tool = (e.target.value || null) as RoleTool | null;
            onChange((d) => ({ ...d, tool }));
          }}
          className={select}
        >
          <option value="">From the look</option>
          {TOOLS.map((tool) => (
            <option key={tool} value={tool}>
              {ROLE_TOOL_TITLES[tool]}
            </option>
          ))}
        </select>
      </label>
    </div>
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
              <HobSprite hob={{ lookSeed: seed, lookColor: draft.lookColor, ...gearOf(draft) }} size={tile - 8} />
            </label>
          ))}
      </div>
    </fieldset>
  );
}

/** The line that sums up how the hob thinks and what its role does. */
export function HobSummary({
  draft,
  model,
  className,
}: {
  draft: FirstHobDraft;
  model: RuntimeModel | undefined;
  className?: string | undefined;
}) {
  const note = draft.role === null ? undefined : starterRole(draft.role).note;
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
  const { main, more } = splitModels(models);
  // The other models start open when the hob already thinks with one, so the choice stays in view.
  const [moreShown, setMoreShown] = useState<boolean | null>(null);
  const moreOpen = moreShown ?? more.some((m) => m.id === draft.model);
  const moreId = useId();
  return (
    <>
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Model</legend>
        {main.map((m) => (
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
      {more.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => setMoreShown(!moreOpen)}
            className="flex items-center gap-2 self-start bg-transparent py-1 text-sm text-label hover:text-text"
          >
            <span aria-hidden className="w-2.5">
              {moreOpen ? "▾" : "▸"}
            </span>
            More models
            <span className="text-[13px]">{more.length}</span>
          </button>
          {moreOpen && (
            <fieldset id={moreId} className="m-0 flex min-w-0 animate-hb-in flex-col border-2 border-line p-1">
              <legend className="sr-only">More models</legend>
              {more.map((m) => {
                const on = m.id === draft.model;
                return (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-sm",
                      on ? "bg-line" : "hover:bg-hover",
                      "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-3",
                    )}
                  >
                    <input
                      type="radio"
                      name="hob-model"
                      checked={on}
                      onChange={() => onChange(pickModel(draft, m))}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={cn("size-2.5 border-2", on ? "border-lantern bg-lantern" : "border-control")}
                    />
                    <span className={cn("w-24 shrink-0 font-bold", on ? "text-moonlight" : "text-text")}>
                      {m.displayName}
                    </span>
                    <span className="min-w-0 text-xs text-label">{m.description}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </div>
      )}
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
