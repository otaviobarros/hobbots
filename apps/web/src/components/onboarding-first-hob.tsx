import type { RuntimeModel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  draftProblem,
  type FirstHobDraft,
  gearOf,
  keepDraft,
  keptDraftOrStored,
  kindLine,
  LABEL_MAX,
  pickLook,
  restoreDraft,
  roleTitleOf,
  rollLook,
  rollName,
  settleBrain,
} from "../api/first-hob.ts";
import { modelsQuery } from "../api/queries.ts";
import { hobLook } from "../art/look.ts";
import {
  Brain,
  ChoresField,
  ColorSwatches,
  Die,
  draftRolePicker,
  GearPicker,
  HobSummary,
  NameDice,
  NearbyLooks,
  RolePicker,
} from "./hob-form.tsx";
import { HobSprite } from "./hob-sprite.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";

const GUIDE = "Now the fun part. Every hob has a role on your team. Pick one, a name and a cloak.";

/** A few stars in the preview's sky, placed once per visit. */
const previewStars = () =>
  Array.from({ length: 9 }, () => ({
    left: 12 + Math.floor(Math.random() * 236),
    top: 70 + Math.floor(Math.random() * 180),
    delay: Math.random() * 3,
  }));

function LookPreview({
  draft,
  roleLine,
  model,
  lookRolls,
  hops,
  onRoll,
  onPickSeed,
  onChange,
}: {
  draft: FirstHobDraft;
  roleLine: string;
  model: RuntimeModel | undefined;
  lookRolls: number;
  /** Changes with every choice, so the hob hops each time. */
  hops: string;
  onRoll: () => void;
  onPickSeed: (seed: number) => void;
  onChange: (update: (draft: FirstHobDraft) => FirstHobDraft) => void;
}) {
  const gear = gearOf(draft);
  const look = useMemo(
    () => hobLook(draft.lookSeed, draft.lookColor, { hat: gear.hat, tool: gear.tool }),
    [draft.lookSeed, draft.lookColor, gear.hat, gear.tool],
  );
  const [stars] = useState(previewStars);
  const name = draft.name.trim() || "your hob";
  return (
    <section
      aria-label="Preview"
      className="cut relative h-[520px] w-[268px] flex-none overflow-hidden border-2 border-line bg-panel"
    >
      {stars.map((star) => (
        <span
          key={`${star.left}-${star.top}`}
          aria-hidden
          className="absolute size-[3px] animate-hb-twinkle bg-[#cfc8ff]"
          style={{ left: star.left, top: star.top, animationDelay: `${star.delay}s` }}
        />
      ))}
      <div aria-hidden className="absolute inset-x-0 top-[280px] h-[240px] bg-[#221d44]" />
      <div aria-hidden className="absolute inset-x-[54px] top-[268px] h-3.5 bg-line-2" />
      <div className="absolute inset-x-0 top-4 flex flex-col items-center gap-0.5 px-4">
        <span className="max-w-full truncate font-pixel text-[26px] font-bold text-moonlight">{name}</span>
        <span className="max-w-full truncate text-sm text-secondary-text">{roleLine}</span>
      </div>
      <button
        type="button"
        onClick={onRoll}
        aria-label="New look"
        title="Click for a new look"
        className="absolute top-[128px] left-[62px] cursor-pointer border-0 bg-transparent p-0 hover:brightness-110"
      >
        <span key={hops} className="block animate-hb-hop">
          <HobSprite hob={{ ...draft, ...gear }} size={140} state="thinking" />
        </span>
      </button>
      {lookRolls > 0 && (
        // A puff as the hob changes its look; it fades by itself and never shows under Reduce motion.
        <span
          key={lookRolls}
          aria-hidden
          className="pointer-events-none absolute top-[120px] left-16 size-[140px] animate-hb-poof rounded-full bg-text motion-reduce:hidden"
        />
      )}
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
        <NearbyLooks draft={draft} onPick={onPickSeed} tile={42} className="flex gap-1.5" />
        <GearPicker draft={draft} onChange={onChange} className="flex-col" />
        <HobSummary draft={draft} model={model} className="pt-1" />
      </div>
    </section>
  );
}

/**
 * Onboarding step 2: the user makes their first hob, with a role, a name from the dice, a seeded
 * look in one of the hob colors, and Claude Code's model and effort. The summon creates it.
 */
export function OnboardingFirstHob() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const models = useQuery(modelsQuery("claude-code"));
  const [draft, setDraft] = useState<FirstHobDraft>(() => restoreDraft(keptDraftOrStored()));
  const [nameRolls, setNameRolls] = useState(0);
  const [lookRolls, setLookRolls] = useState(0);
  const [tried, setTried] = useState(false);

  // Coming back to this step keeps what was chosen; a model the runtime dropped falls back,
  // unless the hob was already sent with it.
  useEffect(() => keepDraft(draft), [draft]);
  useEffect(() => {
    if (models.data) setDraft((d) => (d.submitted ? d : settleBrain(d, models.data)));
  }, [models.data]);

  const model = models.data?.models.find((m) => m.id === draft.model);
  const locked = draft.submitted !== null;
  const problem = locked
    ? undefined
    : (draftProblem(draft) ?? (model ? undefined : "Waiting for Claude Code's models"));

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/providers" }));
  // The draft waits in storage; the summon at the end of setup creates the hob.
  const next = () => {
    setTried(true);
    if (problem) return;
    void navigate({ to: "/setup/safety" });
  };

  const roleLine = kindLine(draft);
  const hint = locked
    ? `${draft.name.trim()} is on the way. Finish summoning to change it.`
    : (problem ?? `${draft.name.trim()} the ${roleTitleOf(draft)} is ready`);

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
            className={cn("flex-1 text-right text-sm", problem && tried ? "text-lantern" : "text-secondary-text")}
          >
            {hint}
          </span>
          <Button
            onClick={next}
            aria-disabled={problem !== undefined}
            aria-describedby="first-hob-hint"
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
            <p className="m-0 mt-1 text-secondary-text">Pick a role or name your own. Every hob looks different.</p>
          </div>

          <RolePicker
            {...draftRolePicker(draft, setDraft)}
            legend={<legend className="lbl mb-2 text-label">Role</legend>}
            columns={2}
          />

          <ChoresField
            draft={draft}
            onChange={setDraft}
            rows={2}
            label={`What should ${draft.name.trim() || "your hob"} do?`}
            className="lbl text-label"
          />

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
                <NameDice
                  size={22}
                  rolls={nameRolls}
                  onRoll={() => {
                    setDraft((d) => ({ ...d, name: rollName(d.name), named: true }));
                    setNameRolls((n) => n + 1);
                  }}
                  className="size-11"
                />
              </div>
            </div>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="lbl mb-2 text-label">Colors</legend>
              <ColorSwatches
                value={draft.lookColor}
                onPick={(lookColor) => setDraft((d) => ({ ...d, lookColor }))}
                className="flex gap-[5px]"
              />
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
          roleLine={roleLine}
          model={model}
          lookRolls={lookRolls}
          onChange={setDraft}
          hops={[
            draft.role,
            draft.hat,
            draft.tool,
            draft.lookColor,
            draft.lookSeed,
            draft.model,
            draft.effort,
            nameRolls,
          ].join(" ")}
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
