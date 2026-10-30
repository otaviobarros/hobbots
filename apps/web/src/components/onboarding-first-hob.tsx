import type { Effort, HobColor, RuntimeModel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  CRAFTS,
  craftOf,
  draftProblem,
  effortWords,
  type FirstHobDraft,
  LABEL_MAX,
  nearbySeeds,
  pickCraft,
  pickLook,
  pickModel,
  reopenDraft,
  restoreDraft,
  rollLook,
  rollName,
  settleBrain,
  submitDraft,
} from "../api/first-hob.ts";
import { modelsQuery, useCreateHob } from "../api/queries.ts";
import { useUpdateSetup } from "../api/setup.ts";
import { HOB_COLORS, hobLook } from "../art/look.ts";
import { readStored, writeStored } from "../lib/storage.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";

const GUIDE = "Now the fun part. Every hob is good at something. Pick a craft, a name and a cloak.";
const draftKey = "setup.firstHob";

const DIE = ["owwwo", "wwwww", "wwoww", "wwwww", "owwwo"];
const DIE_PALETTE = { o: "#141228", w: "#ece8ff" };

/** A die that turns a quarter at a time each time it is rolled. */
function Die({ size, rolls }: { size: number; rolls: number }) {
  return (
    <span key={rolls} className={cn("block", rolls > 0 && "animate-hb-roll")}>
      <PixelArt rows={DIE} palette={DIE_PALETTE} size={size} />
    </span>
  );
}

/** A focus ring drawn inside the pixel corners, which would clip one drawn outside. */
const focusWithin =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-4";

/**
 * One option of a radio group, drawn as a chip. A native radio underneath gives arrow keys,
 * Space and screen readers the group's real behavior.
 */
function Choice({
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

function Brain({
  models,
  draft,
  onChange,
}: {
  models: ReadonlyArray<RuntimeModel>;
  draft: FirstHobDraft;
  onChange: (draft: FirstHobDraft) => void;
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
            <span className="max-w-[220px] truncate text-xs opacity-85">{m.description}</span>
          </Choice>
        ))}
      </fieldset>
      {efforts.length > 0 ? (
        <fieldset className="m-0 flex flex-wrap items-center gap-3 border-0 p-0">
          <legend className="float-left mr-3 text-sm font-bold">Effort</legend>
          <div className="flex border-2 border-control">
            {efforts.map((effort: Effort, i) => {
              const on = effort === draft.effort;
              return (
                <label
                  key={effort}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 px-[11px] py-1.5 text-sm",
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

function LookPreview({
  draft,
  craftLine,
  craftNote,
  brainLine,
  lookRolls,
  onRoll,
  onPickSeed,
}: {
  draft: FirstHobDraft;
  craftLine: string;
  craftNote: string;
  brainLine: string;
  lookRolls: number;
  onRoll: () => void;
  onPickSeed: (seed: number) => void;
}) {
  const look = useMemo(() => hobLook(draft.lookSeed, draft.lookColor), [draft.lookSeed, draft.lookColor]);
  const name = draft.name.trim() || "your hob";
  return (
    <section
      aria-label="Preview"
      className="cut relative h-[520px] w-[268px] flex-none overflow-hidden border-2 border-line bg-panel"
    >
      <div aria-hidden className="absolute inset-x-0 top-[280px] h-[240px] bg-[#221d44]" />
      <div aria-hidden className="absolute inset-x-[54px] top-[268px] h-3.5 bg-line-2" />
      <div className="absolute inset-x-0 top-4 flex flex-col items-center gap-0.5 px-4">
        <span className="max-w-full truncate font-pixel text-[26px] font-bold text-moonlight">{name}</span>
        <span className="max-w-full truncate text-sm text-secondary-text">{craftLine}</span>
      </div>
      <button
        type="button"
        onClick={onRoll}
        aria-label="New look"
        title="Click for a new look"
        className="absolute top-[128px] left-[62px] cursor-pointer border-0 bg-transparent p-0 hover:brightness-110"
      >
        <span key={lookRolls} className="block animate-hb-pop">
          <HobSprite hob={draft} size={140} state="thinking" />
        </span>
      </button>
      <div className="absolute inset-x-4 top-[296px] flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span aria-live="polite" className="min-w-0 flex-1 text-[13px] text-secondary-text">
            Look <b className="text-text tabular-nums">#{draft.lookSeed}</b> · {look.recipe}
          </span>
          <Button variant="outline" size="xs" onClick={onRoll}>
            <Die size={14} rolls={lookRolls} />
            New look
          </Button>
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="lbl mb-1.5 text-xs text-label">More like this</legend>
          <div className="flex gap-1.5">
            {nearbySeeds(draft.lookBase).map((seed) => (
              <label
                key={seed}
                className={cn(
                  "hop-on-hover grid size-[42px] cursor-pointer place-items-center border-2 bg-line hover:border-moonlight",
                  seed === draft.lookSeed ? "border-moonlight" : "border-line-2",
                  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight",
                )}
              >
                <input
                  type="radio"
                  name="hob-look"
                  checked={seed === draft.lookSeed}
                  onChange={() => onPickSeed(seed)}
                  aria-label={`Look ${seed}`}
                  className="sr-only"
                />
                <HobSprite hob={{ lookSeed: seed, lookColor: draft.lookColor }} size={34} />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-[3px] pt-1 text-[13px] text-secondary-text">
          <span>
            Thinks with <b className="text-text">{brainLine}</b>
          </span>
          <span>{craftNote}</span>
        </div>
      </div>
    </section>
  );
}

/**
 * Onboarding step 2: the user makes their first hob, with a craft, a name from the dice, a seeded
 * look in one of the hob colors, and Claude Code's model and effort. Continue creates the hob.
 */
export function OnboardingFirstHob() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const models = useQuery(modelsQuery("claude-code"));
  const create = useCreateHob();
  const update = useUpdateSetup();
  const [draft, setDraft] = useState<FirstHobDraft>(() =>
    restoreDraft(readStored<Partial<FirstHobDraft> | null>(draftKey, null)),
  );
  const [nameRolls, setNameRolls] = useState(0);
  const [lookRolls, setLookRolls] = useState(0);
  const [tried, setTried] = useState(false);

  // Coming back to this step keeps what was chosen; a model the runtime dropped falls back,
  // unless the hob was already sent with it.
  useEffect(() => writeStored(draftKey, draft), [draft]);
  useEffect(() => {
    if (models.data) setDraft((d) => (d.submitted ? d : settleBrain(d, models.data)));
  }, [models.data]);

  const craft = CRAFTS.find((c) => c.kind === draft.kind) ?? CRAFTS[0];
  const model = models.data?.models.find((m) => m.id === draft.model);
  const locked = draft.submitted !== null;
  const problem = locked
    ? undefined
    : (draftProblem(draft) ?? (model ? undefined : "Waiting for Claude Code's models"));
  const busy = create.isPending || update.isPending;
  const failed = create.isError || update.isError;
  const rejected = create.error instanceof ApiError && create.error.tag === "InvalidHob" ? create.error : undefined;

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/providers" }));
  // Safety, folders and the summon (#69) come next; until they exist, creating the hob ends setup.
  const next = async () => {
    setTried(true);
    if (problem || busy) return;
    // Once sent, the hob may exist even when no answer comes back, so the choices lock and every
    // retry repeats the same request; the hub returns the hob it made the first time.
    const sent = submitDraft(draft);
    setDraft(sent);
    try {
      await create.mutateAsync(sent.submitted);
    } catch (error) {
      if (error instanceof ApiError && error.tag === "InvalidHob") setDraft(reopenDraft);
      return;
    }
    try {
      await update.mutateAsync({ completed: true });
      writeStored(draftKey, null);
      await navigate({ to: "/" });
    } catch {
      // The footer shows the failure from the mutation state.
    }
  };

  const craftLine =
    draft.kind === "custom"
      ? draft.craft.trim()
        ? `good at ${draft.craft.trim().toLowerCase()}`
        : "one of a kind"
      : `the ${craft?.label}`;
  const brainLine = `Claude · ${model?.displayName ?? "…"}${draft.effort ? ` · ${effortWords(draft.effort).label.toLowerCase()} effort` : ""}`;
  const hint = rejected
    ? `Hobbots could not create your hob: ${rejected.message}`
    : failed
      ? `Hobbots could not finish making ${draft.name.trim()}. Try again in a moment.`
      : busy
        ? `Making ${draft.name.trim()}…`
        : problem && (tried || !model)
          ? problem
          : `${draft.name.trim()} the ${craftOf(draft) || "hob"} is ready`;

  return (
    <OnboardingFrame
      step={1}
      guide={GUIDE}
      sofar={["Claude connected"]}
      footer={
        <>
          <Button variant="outline" onClick={back}>
            Back
          </Button>
          <span
            id="first-hob-hint"
            role={failed ? "alert" : undefined}
            className={cn(
              "flex-1 text-right text-sm",
              failed ? "text-rose" : problem && (tried || !model) ? "text-lantern" : "text-secondary-text",
            )}
          >
            {hint}
          </span>
          <Button
            onClick={() => void next()}
            aria-disabled={problem !== undefined}
            aria-describedby="first-hob-hint"
            disabled={busy}
            className={
              problem ? "cursor-not-allowed bg-line-2 text-label shadow-[0_4px_0_#22203f] hover:bg-line-2" : undefined
            }
          >
            Continue
          </Button>
        </>
      }
    >
      {/* Disabled once sent: the hob may already exist with exactly these choices. */}
      <fieldset disabled={locked} className="m-0 flex min-w-0 animate-hb-in gap-6 border-0 p-0 disabled:opacity-85">
        <legend className="sr-only">{locked ? `${draft.name.trim()}, as sent` : "Your first hob"}</legend>
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <div>
            <h1 className="m-0 font-pixel text-[30px] font-bold text-moonlight">Meet your first hob</h1>
            <p className="m-0 mt-1 text-secondary-text">
              Pick a craft or describe your own. Every hob looks different.
            </p>
          </div>

          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="lbl mb-2 text-label">Good at</legend>
            <div className="flex flex-wrap gap-2">
              {CRAFTS.map((c) => (
                <Choice
                  key={c.kind}
                  name="hob-craft"
                  checked={draft.kind === c.kind}
                  onPick={() => setDraft((d) => pickCraft(d, c.kind))}
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
                onChange={(e) => setDraft((d) => ({ ...d, craft: e.target.value }))}
                placeholder="What should it be good at? e.g. planning my garden"
                aria-label="Your own craft"
                className="animate-hb-in border-2 border-lantern bg-deep px-[11px] py-[9px] text-[15px] text-text"
              />
            )}
          </fieldset>

          <div className="flex flex-wrap items-end gap-6">
            <div className="flex flex-col gap-2">
              <label htmlFor="hob-name" className="lbl text-label">
                Name
              </label>
              <div className="flex gap-1.5">
                <input
                  id="hob-name"
                  value={draft.name}
                  maxLength={LABEL_MAX}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, named: true }))}
                  className="w-[150px] border-2 border-control bg-deep px-2.5 py-[7px] font-pixel text-xl font-bold text-text"
                />
                <Button
                  variant="icon"
                  onClick={() => {
                    setDraft((d) => ({ ...d, name: rollName(d.name), named: true }));
                    setNameRolls((n) => n + 1);
                  }}
                  aria-label="Random name"
                  title="Random name"
                  className="cut size-11 border-control bg-line hover:bg-line-2"
                >
                  <Die size={22} rolls={nameRolls} />
                </Button>
              </div>
            </div>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="lbl mb-2 text-label">Colors</legend>
              <div className="flex gap-[5px]">
                {(Object.keys(HOB_COLORS) as Array<HobColor>).map((id) => {
                  const color = HOB_COLORS[id];
                  const on = draft.lookColor === id;
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
                        onChange={() => setDraft((d) => ({ ...d, lookColor: id }))}
                        aria-label={color.label}
                        className="sr-only"
                      />
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>

          <div className="flex flex-col gap-2">
            <span className="lbl text-label">Thinks with</span>
            <div className="flex flex-wrap gap-2">
              <span className="cut flex items-center gap-2 border-2 border-moonlight bg-line px-3 py-[7px] text-sm">
                <span
                  aria-hidden
                  className="grid size-5 place-items-center bg-[#e39a74] text-[13px] font-bold text-ground"
                >
                  C
                </span>
                Claude
              </span>
            </div>
            {models.isPending ? (
              <span className="py-2 text-sm text-lantern">
                Asking Claude Code for its models <span className="animate-hb-blink">•••</span>
              </span>
            ) : models.isError ? (
              <span role="alert" className="flex items-center gap-3 text-sm text-rose">
                Hobbots could not get Claude Code's models.
                <Button variant="outline" size="xs" onClick={() => void models.refetch()}>
                  Try again
                </Button>
              </span>
            ) : (
              <Brain models={models.data.models} draft={draft} onChange={setDraft} />
            )}
          </div>
        </div>

        <LookPreview
          draft={draft}
          craftLine={craftLine}
          craftNote={craft?.note ?? ""}
          brainLine={brainLine}
          lookRolls={lookRolls}
          onRoll={() => {
            setDraft((d) => rollLook(d));
            setLookRolls((n) => n + 1);
          }}
          onPickSeed={(seed) => {
            setDraft((d) => pickLook(d, seed));
            setLookRolls((n) => n + 1);
          }}
        />
      </fieldset>
    </OnboardingFrame>
  );
}
