import { HOB_COLORS, hobLook } from "@hobbots/art/look";
import {
  type Effort,
  type HobColor,
  PICKER_FIRST,
  ROLE_HAT_TITLES,
  ROLE_TOOL_TITLES,
  type RoleHat,
  type RoleId,
  type RoleTool,
  RUNTIME_NAMES,
  type RuntimeKind,
  type RuntimeModel,
  type RuntimeModels,
  starterRole,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { cn } from "@hobbots/ui/lib/utils";
import type { UseQueryResult } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useId, useState } from "react";
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
  settleBrain,
  settleRuntime,
  splitModels,
  thinksWith,
} from "../../api/first-hob.ts";
import { DIE, DIE_PALETTE } from "../../art/icons.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { RoleSigil } from "../roles/role-sigil.tsx";

/**
 * The hob fields that onboarding's first hob and Summon share: chores, role, name dice, colors,
 * hat and tool, nearby looks, the model and effort a hob thinks with, and the line that sums it up. Each screen
 * lays them out its own way, but both offer the same choices.
 */

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
      aria-label={messages.hobForm.rollName}
      title={messages.hobForm.rollName}
      className={cn("cut border-control bg-line hover:bg-line-2", className)}
    >
      <Die size={size} rolls={rolls} />
    </Button>
  );
}

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
    <RadioLabel
      name={name}
      checked={checked}
      onPick={onPick}
      label={label}
      className={cn(
        "cut flex cursor-pointer items-center gap-2 border-2 px-3 py-[7px] text-sm",
        checked ? "border-text-strong bg-selected text-text-strong" : "border-control text-text-strong hover:bg-line",
        "focus-ring-within",
        className,
      )}
    >
      {children}
    </RadioLabel>
  );
}

/** What a label over a native radio takes: the group, whether it is on, and what picking it does. */
export interface RadioLabelProps {
  name: string;
  checked: boolean;
  onPick: () => void;
  /** The radio's name when the visible text is not enough, such as a look drawn as a picture. */
  label?: string | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}

/** A label over a visually hidden native radio, so the browser gives the group its keys and names. */
export function RadioLabel({ name, checked, onPick, label, className, children }: RadioLabelProps) {
  return (
    <label className={className}>
      <input type="radio" name={name} checked={checked} onChange={onPick} aria-label={label} className="sr-only" />
      {children}
    </label>
  );
}

/**
 * A text field's look: the control edge, the focus ring, and the skin's corner and edge width, so it
 * fits every theme.
 */
export const FIELD =
  "rounded-control border-(length:--edge) border-solid border-control bg-card px-2.5 py-2 text-body text-text placeholder:text-label focus-ring";

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
        placeholder={messages.hobForm.choresPlaceholder}
        className={cn("resize-none leading-normal", FIELD)}
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
  name,
  className,
}: {
  checked: boolean;
  name: string;
  onPick: () => void;
  sigil: RoleId | null;
  title: string;
  note: string;
  className?: string | undefined;
}) {
  return (
    <label
      className={cn(
        "cut relative flex min-w-0 cursor-pointer items-start gap-2.5 border-2 px-2.5 py-2 text-start",
        checked ? "border-text-strong bg-selected" : "border-line hover:bg-hover",
        "focus-ring-within",
        className,
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onPick} className="sr-only" />
      {sigil ? (
        <RoleSigil sigil={sigil} size={20} className="mt-0.5 flex-none" />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 grid size-5 flex-none place-items-center border-2 border-dashed border-control text-xs text-label"
        >
          +
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-sm font-bold", checked ? "text-moonlight" : "text-text-strong")}>{title}</span>
        <span className="text-xs leading-snug text-text-secondary">{note}</span>
      </span>
    </label>
  );
}

const roleOption = (id: RoleId) => {
  const role = starterRole(id);
  return { sigil: id, title: role.title, note: role.note };
};

/**
 * The role picker: the first eight roles, then "More roles" under their families, then "Your own",
 * which takes a title in the user's words and any sigil from the set. One radio group runs through
 * all of them, so arrow keys move from role to role. A link at the end asks for a missing role.
 */
export function RolePicker({
  value,
  onPick,
  onOwnTitle,
  onOwnSigil,
  legend,
  columns = 3,
  disabled = false,
}: {
  value: RolePick;
  onPick: (role: RoleId | null) => void;
  onOwnTitle: (title: string) => void;
  onOwnSigil: (sigil: RoleId) => void;
  legend: React.ReactNode;
  /** How many roles sit side by side; the screen picks what fits. */
  columns?: 2 | 3;
  disabled?: boolean;
}) {
  const draft = value;
  const inMore = draft.role !== null && !PICKER_FIRST.includes(draft.role);
  // "More roles" starts open when the hob already has one of them, so the choice stays in view.
  const [moreShown, setMoreShown] = useState<boolean | null>(null);
  const moreOpen = moreShown ?? inMore;
  const moreId = useId();
  const name = useId();
  const own = draft.role === null;
  // Picking "Your own" asks for the title right away; a hob that already has one keeps the focus where it is.
  const [ownPicked, setOwnPicked] = useState(false);
  const grid = columns === 3 ? "grid-cols-3" : "grid-cols-2";
  const moreCount = MORE_ROLES.reduce((n, group) => n + group.roles.length, 0);
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      {legend}
      <div className={cn("grid gap-1.5", grid)}>
        {PICKER_FIRST.map((id) => (
          <RoleOption key={id} checked={draft.role === id} onPick={() => onPick(id)} name={name} {...roleOption(id)} />
        ))}
      </div>
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-controls={moreId}
        onClick={() => setMoreShown(!moreOpen)}
        className="flex items-center gap-2 self-start bg-transparent py-1 text-sm text-label hover:text-text-strong"
      >
        <span aria-hidden className="w-2.5">
          {moreOpen ? "▾" : "▸"}
        </span>
        {messages.hobForm.moreRoles}
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
                    onPick={() => onPick(id)}
                    name={name}
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
        onPick={() => {
          setOwnPicked(true);
          onPick(null);
        }}
        name={name}
        sigil={own ? draft.ownSigil : null}
        title={messages.hobForm.ownRole}
        note={messages.hobForm.ownRoleNote}
        className={cn("self-start", !own && "border-dashed")}
      />
      {own && <OwnRole value={draft} onTitle={onOwnTitle} onSigil={onOwnSigil} autoFocus={ownPicked} />}
      <a
        href={roleRequestUrl(own ? draft.ownTitle : "")}
        target="_blank"
        rel="noreferrer"
        className="self-start text-[13px]"
      >
        {messages.hobForm.suggestRole}
      </a>
    </fieldset>
  );
}

/** What the role picker shows: a starter role, or a title in the user's words with a borrowed sigil. */
export interface RolePick {
  readonly role: RoleId | null;
  readonly ownTitle: string;
  readonly ownSigil: RoleId;
}

/** Wires the role picker to a hob form draft. */
export const draftRolePicker = <D extends FirstHobDraft>(draft: D, onChange: (update: (draft: D) => D) => void) => ({
  value: draft,
  onPick: (role: RoleId | null) => onChange((d) => pickRole(d, role)),
  onOwnTitle: (ownTitle: string) => onChange((d) => ({ ...d, ownTitle })),
  onOwnSigil: (ownSigil: RoleId) => onChange((d) => ({ ...d, ownSigil })),
});

/** A role title in the user's own words, with a sigil borrowed from any starter role. */
export function OwnRole({
  value,
  onTitle,
  onSigil,
  autoFocus,
}: {
  value: RolePick;
  autoFocus: boolean;
  onTitle: (title: string) => void;
  onSigil: (sigil: RoleId) => void;
}) {
  return (
    <div className="flex animate-hb-in flex-col gap-2.5 border-2 border-line p-2.5">
      <input
        // biome-ignore lint/a11y/noAutofocus: choosing "Your own" asks for the title right away.
        autoFocus={autoFocus}
        value={value.ownTitle}
        maxLength={LABEL_MAX}
        onChange={(e) => onTitle(e.target.value)}
        placeholder={messages.hobForm.ownTitlePlaceholder}
        aria-label={messages.hobForm.ownTitle}
        className="border-2 border-lantern bg-deep px-[11px] py-[9px] text-[15px] text-text-strong"
      />
      <SigilPicker
        value={value.ownSigil}
        onPick={onSigil}
        legend={<legend className="mb-1.5 text-[13px] text-text-secondary">{messages.hobForm.sigil}</legend>}
        className="flex flex-wrap gap-1"
        tileClassName="size-8 border-2 border-line bg-deep hover:border-control data-on:border-text-strong data-on:hover:border-text-strong"
      />
    </div>
  );
}

/**
 * Any starter role's sigil, for a title in the user's words. One radio group, so arrow keys move
 * from sigil to sigil and Tab enters it on the one picked.
 */
export function SigilPicker({
  value,
  onPick,
  legend,
  className,
  tileClassName,
}: {
  value: RoleId;
  onPick: (sigil: RoleId) => void;
  legend: React.ReactNode;
  className?: string | undefined;
  tileClassName?: string | undefined;
}) {
  const name = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      {legend}
      <div className={className}>
        {ALL_ROLES.map((id) => {
          const on = value === id;
          return (
            <label
              key={id}
              title={starterRole(id).title}
              data-on={on || undefined}
              className={cn("relative grid cursor-pointer place-items-center", "focus-ring-within", tileClassName)}
            >
              <input
                type="radio"
                name={name}
                checked={on}
                onChange={() => onPick(id)}
                aria-label={messages.hobForm.roleSigil({ role: starterRole(id).title })}
                className="sr-only"
              />
              <RoleSigil sigil={id} size={20} />
            </label>
          );
        })}
      </div>
    </fieldset>
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
  const select = "min-w-0 flex-1 border-2 border-control bg-deep px-2 py-1 text-[13px] text-text-strong";
  return (
    <div className={cn("flex gap-2", className)}>
      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-label">
        {messages.hobForm.hat}
        <select
          value={draft.hat ?? ""}
          onChange={(e) => {
            const hat = (e.target.value || null) as RoleHat | null;
            onChange((d) => ({ ...d, hat }));
          }}
          className={select}
        >
          <option value="">{messages.hobForm.fromLook}</option>
          {HATS.map((hat) => (
            <option key={hat} value={hat}>
              {ROLE_HAT_TITLES[hat]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-label">
        {messages.hobForm.tool}
        <select
          value={draft.tool ?? ""}
          onChange={(e) => {
            const tool = (e.target.value || null) as RoleTool | null;
            onChange((d) => ({ ...d, tool }));
          }}
          className={select}
        >
          <option value="">{messages.hobForm.fromLook}</option>
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
              "focus-ring-within",
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
      <legend className="lbl mb-1.5 text-xs text-label">{messages.hobForm.moreLikeThis}</legend>
      <div className={className}>
        {nearbySeeds(draft.lookBase)
          .slice(0, count)
          .map((seed) => (
            <label
              key={seed}
              className={cn(
                "hop-on-hover grid cursor-pointer place-items-center border-2 bg-line hover:border-moonlight",
                seed === draft.lookSeed ? "border-moonlight" : "border-line-2",
                "focus-ring-within",
              )}
              style={{ width: tile, height: tile }}
            >
              <input
                type="radio"
                name="hob-look"
                checked={seed === draft.lookSeed}
                onChange={() => onPick(seed)}
                aria-label={messages.hobForm.lookN({ n: seed })}
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
  const [before, after] = messages.models.thinksWith.split("{brain}");
  return (
    <div className={cn("flex flex-col gap-[3px] text-[13px] text-text-secondary", className)}>
      <span>
        {before}
        <b className="text-text-strong">{thinksWith(draft, model)}</b>
        {after}
      </span>
      {note && <span>{note}</span>}
    </div>
  );
}

function EffortBars({ index, count }: { index: number; count: number }) {
  return (
    <span aria-hidden className="flex items-end gap-0.5">
      {Array.from({ length: count }, (_, j) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed row of identical marks.
          key={j}
          className={cn("w-[3px]", j <= index ? "bg-current" : "bg-line-2")}
          style={{ height: 4 + j * 3 }}
        />
      ))}
    </span>
  );
}

/**
 * The model and effort a hob thinks with, with what each model is for and what the effort costs.
 * The hob profile edits an existing hob's brain with it too.
 */
function Brain<D extends BrainChoice>({
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
        <legend className="sr-only">{messages.hobForm.model}</legend>
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
            className="flex items-center gap-2 self-start bg-transparent py-1 text-sm text-label hover:text-text-strong"
          >
            <span aria-hidden className="w-2.5">
              {moreOpen ? "▾" : "▸"}
            </span>
            {messages.models.more}
            <span className="text-[13px]">{more.length}</span>
          </button>
          {moreOpen && (
            <fieldset id={moreId} className="m-0 flex min-w-0 animate-hb-in flex-col border-2 border-line p-1">
              <legend className="sr-only">{messages.models.more}</legend>
              {more.map((m) => {
                const on = m.id === draft.model;
                return (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-sm",
                      on ? "bg-selected" : "hover:bg-hover",
                      "focus-ring-within focus-inset",
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
                      className={cn("size-2.5 border-2", on ? "border-moonlight bg-moonlight" : "border-control")}
                    />
                    <span className={cn("w-24 shrink-0 font-bold", on ? "text-moonlight" : "text-text-strong")}>
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
        <div className="flex flex-wrap items-center gap-3">
          {/* The control carries the name; the visible label only repeats it. */}
          <span aria-hidden className="text-sm font-bold">
            {messages.models.effort}
          </span>
          <SegmentedControl
            aria-label={messages.models.effort}
            value={draft.effort ?? null}
            onValueChange={(effort: Effort) => onChange({ ...draft, effort })}
            className="flex-wrap"
          >
            {efforts.map((effort: Effort, i) => (
              <SegmentedControlItem key={effort} value={effort}>
                <EffortBars index={i} count={efforts.length} />
                {effortWords(effort).label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {draft.effort && (
            <span key={draft.effort} className="animate-hb-in text-[13px] text-text-secondary">
              {effortWords(draft.effort).note}
            </span>
          )}
        </div>
      ) : (
        model && (
          <span className="text-[13px] text-label">{messages.models.noEffort({ model: model.displayName })}</span>
        )
      )}
    </>
  );
}

/** The brain picker once the runtime has listed its models, with the wait and the failure before it. */
export function ModelsBrain<D extends BrainChoice>({
  models,
  draft,
  onChange,
  waitingClassName = "py-1",
}: {
  models: UseQueryResult<RuntimeModels>;
  draft: D;
  onChange: (draft: D) => void;
  waitingClassName?: string;
}) {
  if (models.isPending) {
    return (
      <span className={cn("text-sm text-lantern", waitingClassName)}>
        {messages.models.loading({ runtime: RUNTIME_NAMES[draft.runtime] })}{" "}
        <span className="animate-hb-blink">•••</span>
      </span>
    );
  }
  if (models.isError) {
    return (
      <span role="alert" className="flex items-center gap-3 text-sm text-rose">
        {messages.models.failed({ runtime: RUNTIME_NAMES[draft.runtime] })}
        <Button type="button" variant="outline" size="xs" onClick={() => void models.refetch()}>
          {messages.models.retry}
        </Button>
      </span>
    );
  }
  return <Brain models={models.data.models} draft={draft} onChange={onChange} />;
}

/** The look a draft's seed, color and gear give. */
export const useDraftLook = (draft: FirstHobDraft) => {
  const gear = gearOf(draft);
  return hobLook(draft.lookSeed, draft.lookColor, { hat: gear.hat, tool: gear.tool });
};

/** Moves an unsent draft off a model the runtime no longer lists, each time the list arrives. */
export const useSettledBrain = (
  models: RuntimeModels | undefined,
  setDraft: Dispatch<SetStateAction<FirstHobDraft>>,
) => {
  useEffect(() => {
    if (models) setDraft((d) => (d.submitted ? d : settleBrain(d, models)));
  }, [models, setDraft]);
};

/**
 * Moves an unsent draft off a provider that cannot think now, to the first ready one, each time the
 * ready providers change. With none ready, the draft keeps its provider.
 */
export const useSettledRuntime = (
  ready: ReadonlyArray<RuntimeKind>,
  setDraft: Dispatch<SetStateAction<FirstHobDraft>>,
) => {
  const key = ready.join(" ");
  useEffect(() => {
    const runtimes = key === "" ? [] : (key.split(" ") as ReadonlyArray<RuntimeKind>);
    setDraft((d) => settleRuntime(d, runtimes));
  }, [key, setDraft]);
};
