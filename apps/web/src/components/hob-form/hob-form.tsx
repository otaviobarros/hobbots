import {
  type Effort,
  type RoleId,
  RUNTIME_NAMES,
  type RuntimeKind,
  type RuntimeModel,
  type RuntimeModels,
  starterRole,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Skeleton, WaitNote } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useWaitStage } from "@hobbots/ui/lib/wait-stage";
import type { UseQueryResult } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useId, useState } from "react";
import {
  ALL_ROLES,
  type BrainChoice,
  CHORES_MAX,
  effortWords,
  type FirstHobDraft,
  LABEL_MAX,
  pickModel,
  pickRole,
  settleBrain,
  settleRuntime,
  splitModels,
} from "../../api/first-hob.ts";
import { DIE, DIE_PALETTE } from "../../art/icons.ts";
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
        "cut flex cursor-pointer items-center gap-2 border-(length:--edge) px-3 py-[7px] text-ui",
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
      <span id="hob-chores-note" className="text-detail text-label">
        {draft.choresEdited
          ? "In your words. Hobbots adds them to the hob's instructions."
          : draft.role === null
            ? "Tell it about the chores in your own words."
            : "Filled in from the role. Write it in your own words."}
      </span>
    </div>
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
    <div className="flex animate-hb-in flex-col gap-2.5 border-(length:--edge) border-line p-2.5">
      <input
        // biome-ignore lint/a11y/noAutofocus: choosing "Your own" asks for the title right away.
        autoFocus={autoFocus}
        value={value.ownTitle}
        maxLength={LABEL_MAX}
        onChange={(e) => onTitle(e.target.value)}
        placeholder={messages.hobForm.ownTitlePlaceholder}
        aria-label={messages.hobForm.ownTitle}
        className="border-(length:--edge) border-lantern bg-deep px-[11px] py-[9px] text-[15px] text-text-strong"
      />
      <SigilPicker
        value={value.ownSigil}
        onPick={onSigil}
        legend={<legend className="mb-1.5 text-detail text-text-secondary">{messages.hobForm.sigil}</legend>}
        className="flex flex-wrap gap-1"
        tileClassName="size-8 border-(length:--edge) border-line bg-deep hover:border-control data-on:border-text-strong data-on:hover:border-text-strong"
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
            <span className="max-w-[220px] text-meta opacity-85">{m.description}</span>
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
            className="flex items-center gap-2 self-start bg-transparent py-1 text-ui text-label hover:text-text-strong"
          >
            <span aria-hidden className="w-2.5">
              {moreOpen ? "▾" : "▸"}
            </span>
            {messages.models.more}
            <span className="text-detail">{more.length}</span>
          </button>
          {moreOpen && (
            <fieldset
              id={moreId}
              className="m-0 flex min-w-0 animate-hb-in flex-col border-(length:--edge) border-line p-1"
            >
              <legend className="sr-only">{messages.models.more}</legend>
              {more.map((m) => {
                const on = m.id === draft.model;
                return (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-ui",
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
                      className={cn(
                        "size-2.5 border-(length:--edge)",
                        on ? "border-moonlight bg-moonlight" : "border-control",
                      )}
                    />
                    <span className={cn("w-24 shrink-0 font-bold", on ? "text-moonlight" : "text-text-strong")}>
                      {m.displayName}
                    </span>
                    <span className="min-w-0 text-meta text-label">{m.description}</span>
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
          <span aria-hidden className="text-ui font-bold">
            {messages.models.effort}
          </span>
          <SegmentedControl
            aria-label={messages.models.effort}
            value={draft.effort ?? null}
            onValueChange={(effort: Effort) => onChange({ ...draft, effort })}
          >
            {efforts.map((effort: Effort, i) => (
              <SegmentedControlItem key={effort} value={effort}>
                <EffortBars index={i} count={efforts.length} />
                {effortWords(effort).label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {draft.effort && (
            <span key={draft.effort} className="animate-hb-in text-detail text-text-secondary">
              {effortWords(draft.effort).note}
            </span>
          )}
        </div>
      ) : (
        model && (
          <span className="text-detail text-label">{messages.models.noEffort({ model: model.displayName })}</span>
        )
      )}
    </>
  );
}

/**
 * The brain picker while the runtime lists its models: the model cards with name blocks and Effort
 * in place, disabled, so nothing moves when the list arrives. After a second a line names the
 * runtime it asks, and after ten it offers Try again (Patterns › Loading).
 */
export function ModelsWaiting({
  runtime,
  onRetry,
  surface = "plain",
}: {
  runtime: RuntimeKind;
  onRetry: () => void;
  /** What the picker sits on: `card` where the blocks need `line-2` to show. */
  surface?: Surface | undefined;
}) {
  const wait = useWaitStage(true);
  const name = RUNTIME_NAMES[runtime];
  return (
    <div aria-busy="true" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-2">
        {WAITING_MODELS.map((width) => (
          <span
            key={width}
            className="cut flex flex-col items-start gap-px border-(length:--edge) border-control px-3 py-[5px] text-ui"
          >
            <span className="font-bold">
              <Skeleton width={width} surface={surface} />
            </span>
            <span className="text-meta">
              <Skeleton width="22ch" surface={surface} />
            </span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="text-ui font-bold">
          {messages.models.effort}
        </span>
        <SegmentedControl aria-label={messages.models.effort} value={null} onValueChange={() => undefined} disabled>
          {WAITING_EFFORTS.map((effort, i) => (
            <SegmentedControlItem key={effort} value={effort}>
              <EffortBars index={i} count={WAITING_EFFORTS.length} />
              <Skeleton width="6ch" />
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      <WaitNote
        wait={wait}
        detail={messages.models.loading({ runtime: name })}
        outside={{ note: messages.models.slow({ runtime: name }), retryLabel: messages.models.retry, onRetry }}
      />
    </div>
  );
}

type Surface = "plain" | "card";

/** The likely length of each waiting model card's name. */
const WAITING_MODELS = ["8ch", "10ch", "7ch"] as const;
/** The placeholder segments of the waiting Effort control. */
const WAITING_EFFORTS = ["low", "medium", "high"] as const;

/** The brain picker once the runtime has listed its models, with the wait and the failure before it. */
export function ModelsBrain<D extends BrainChoice>({
  models,
  draft,
  onChange,
  surface,
}: {
  models: UseQueryResult<RuntimeModels>;
  draft: D;
  onChange: (draft: D) => void;
  surface?: Surface | undefined;
}) {
  if (models.isPending) {
    return <ModelsWaiting runtime={draft.runtime} onRetry={() => void models.refetch()} surface={surface} />;
  }
  if (models.isError) {
    return (
      <span role="alert" className="flex items-center gap-3 text-ui text-rose">
        {messages.models.failed({ runtime: RUNTIME_NAMES[draft.runtime] })}
        <Button type="button" variant="outline" size="xs" onClick={() => void models.refetch()}>
          {messages.models.retry}
        </Button>
      </span>
    );
  }
  return <Brain models={models.data.models} draft={draft} onChange={onChange} />;
}

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
