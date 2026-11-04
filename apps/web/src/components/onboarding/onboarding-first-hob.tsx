import { RUNTIME_NAMES, type RuntimeKind, type RuntimeModel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  draftProblem,
  type FirstHobDraft,
  gearOf,
  keepDraft,
  keptDraftOrStored,
  kindLine,
  LABEL_MAX,
  pickLook,
  rerollName,
  restoreDraft,
  roleTitleOf,
  rollLook,
} from "../../api/first-hob.ts";
import { modelsQuery, runtimesQuery } from "../../api/queries.ts";
import { setupQuery } from "../../api/setup.ts";
import { readyProviders } from "../../lib/providers.ts";
import {
  ChoresField,
  ColorSwatches,
  Die,
  draftRolePicker,
  GearPicker,
  HobSummary,
  ModelsBrain,
  NameDice,
  NearbyLooks,
  RolePicker,
  useDraftLook,
  useSettledBrain,
  useSettledRuntime,
} from "../hob-form/hob-form.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { ProviderChoices } from "../providers/provider-choices.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { connectedChip, previewHob, setupSummary } from "./onboarding-preview.ts";

const shared = messages.onboarding;
const copy = messages.onboarding.firstHob;

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
  const look = useDraftLook(draft);
  const [stars] = useState(previewStars);
  const name = draft.name.trim() || copy.yourHob;
  return (
    <section
      aria-label={copy.preview}
      className="cut relative h-[520px] w-[268px] flex-none overflow-hidden border-2 border-line bg-panel"
    >
      {stars.map((star) => (
        <span
          key={`${star.left}-${star.top}`}
          aria-hidden
          className="absolute size-[3px] animate-hb-twinkle bg-scene-star"
          style={{ left: star.left, top: star.top, animationDelay: `${star.delay}s` }}
        />
      ))}
      <div aria-hidden className="absolute inset-x-0 top-[280px] h-[240px] bg-scene-ground" />
      <div aria-hidden className="absolute inset-x-[54px] top-[268px] h-3.5 bg-line-2" />
      <div className="absolute inset-x-0 top-4 flex flex-col items-center gap-0.5 px-4">
        <span className="max-w-full truncate font-heading text-[26px] font-bold text-moonlight">{name}</span>
        <span className="max-w-full truncate text-sm text-text-secondary">{roleLine}</span>
      </div>
      <button
        type="button"
        onClick={onRoll}
        aria-label={copy.newLook}
        title={copy.newLookTitle}
        className="absolute top-[128px] start-[62px] cursor-pointer border-0 bg-transparent p-0 hover:brightness-110"
      >
        <span key={hops} className="block animate-(--hop)">
          <HobSprite hob={{ ...draft, ...gear }} size={140} state="thinking" />
        </span>
      </button>
      {lookRolls > 0 && (
        // A puff as the hob changes its look; it fades by itself and never shows under Reduce motion.
        <span
          key={lookRolls}
          aria-hidden
          className="pointer-events-none absolute top-[120px] start-16 size-[140px] animate-hb-poof rounded-full bg-text-strong motion-reduce:hidden"
        />
      )}
      <div className="absolute inset-x-4 top-[296px] flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span aria-live="polite" className="min-w-0 flex-1 text-[13px] text-text-secondary">
            {copy.look({ seed: draft.lookSeed, recipe: look.recipe })}
          </span>
          <Button variant="outline" size="xs" onClick={onRoll}>
            <Die size={14} rolls={lookRolls} />
            {copy.newLook}
          </Button>
        </div>
        <NearbyLooks draft={draft} onPick={onPickSeed} tile={42} className="flex gap-1.5" />
        <GearPicker draft={draft} onChange={onChange} className="flex-col" />
        <HobSummary draft={draft} model={model} className="pt-1" />
      </div>
    </section>
  );
}

/** What still stops the first hob, in words for the footer; undefined when it can go on. */
const firstHobProblem = (
  draft: FirstHobDraft,
  checking: boolean,
  ready: ReadonlyArray<RuntimeKind>,
  modelFound: boolean,
): string | undefined => {
  const problem = draftProblem(draft);
  if (problem) return problem;
  if (checking) return copy.checking;
  if (!ready.includes(draft.runtime)) return copy.connectReady;
  return modelFound ? undefined : copy.waitingModels({ runtime: RUNTIME_NAMES[draft.runtime] });
};

/** The footer's line: the hob on its way once sent, what still stops it, or that it is ready. */
const firstHobHint = (draft: FirstHobDraft, problem: string | undefined): string => {
  if (draft.submitted !== null) return copy.onTheWay({ name: draft.name.trim() });
  return problem ?? copy.ready({ name: draft.name.trim(), role: roleTitleOf(draft) });
};

/**
 * Onboarding step 2: the user makes their first hob, with a role, a name from the dice, a seeded
 * look in one of the hob colors, and the provider, model and effort it thinks with. The summon creates it.
 */
export function OnboardingFirstHob() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const connected = setup.data?.connectedProviders;
  const [draft, setDraft] = useState<FirstHobDraft>(() => restoreDraft(keptDraftOrStored()));
  const [nameRolls, setNameRolls] = useState(0);
  const [lookRolls, setLookRolls] = useState(0);
  const [tried, setTried] = useState(false);
  const models = useQuery(modelsQuery(draft.runtime));

  // Coming back to this step keeps what was chosen; a model the runtime dropped falls back,
  // unless the hob was already sent with it.
  useEffect(() => keepDraft(draft), [draft]);
  // The first hob thinks with a provider the user connected in the step before.
  const ready = readyProviders(runtimes.data, connected ?? []);
  useSettledRuntime(ready, setDraft);
  useSettledBrain(models.data, setDraft);

  const model = models.data?.models.find((m) => m.id === draft.model);
  const locked = draft.submitted !== null;
  const problem = locked
    ? undefined
    : firstHobProblem(draft, runtimes.isPending || setup.isPending, ready, model !== undefined);

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/providers" }));
  // The draft waits in storage; the summon at the end of setup creates the hob.
  const next = () => {
    setTried(true);
    if (problem) return;
    void navigate({ to: "/setup/safety" });
  };

  const roleLine = kindLine(draft);
  const hint = firstHobHint(draft, problem);

  return (
    <OnboardingFrame
      step={1}
      preview={{
        chip: connectedChip(setup.data),
        hob: previewHob(draft),
        speech: copy.guide,
        summary: setupSummary(1, setup.data, draft),
      }}
      footer={
        <>
          <span
            id="first-hob-hint"
            className={cn("flex-1 text-sm", problem && tried ? "text-lantern" : "text-text-secondary")}
          >
            {hint}
          </span>
          <Button variant="outline" onClick={back}>
            {shared.back}
          </Button>
          <Button
            onClick={next}
            aria-disabled={problem !== undefined}
            aria-describedby="first-hob-hint"
            className={
              problem
                ? "cursor-not-allowed bg-line-2 text-label shadow-[0_4px_0_color-mix(in_srgb,var(--color-line-2)_60%,black)] hover:bg-line-2"
                : undefined
            }
          >
            {shared.continue}
          </Button>
        </>
      }
    >
      {/* Disabled once sent: the hob may already exist with exactly these choices. */}
      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0 disabled:opacity-85">
        <legend className="sr-only">{locked ? copy.legendSent({ name: draft.name.trim() }) : copy.legend}</legend>
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <div>
            <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.heading}</h1>
            <p className="m-0 mt-1 text-text-secondary">{copy.intro}</p>
          </div>

          <RolePicker
            {...draftRolePicker(draft, setDraft)}
            legend={<legend className="lbl mb-2 text-label">{copy.role}</legend>}
            columns={2}
          />

          <ChoresField
            draft={draft}
            onChange={setDraft}
            rows={2}
            label={copy.chores({ name: draft.name.trim() || copy.yourHob })}
            className="lbl text-label"
          />

          <div className="flex flex-wrap items-end gap-6">
            <div className="flex flex-col gap-2">
              <label htmlFor="hob-name" className="lbl text-label">
                {copy.name}
              </label>
              <div className="flex gap-1.5">
                <input
                  id="hob-name"
                  value={draft.name}
                  maxLength={LABEL_MAX}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, named: true }))}
                  className="w-[150px] border-2 border-control bg-deep px-2.5 py-[7px] font-heading text-xl font-bold text-text-strong"
                />
                <NameDice
                  size={22}
                  rolls={nameRolls}
                  onRoll={() => {
                    setDraft(rerollName);
                    setNameRolls((n) => n + 1);
                  }}
                  className="size-11"
                />
              </div>
            </div>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="lbl mb-2 text-label">{copy.colors}</legend>
              <ColorSwatches
                value={draft.lookColor}
                onPick={(lookColor) => setDraft((d) => ({ ...d, lookColor }))}
                className="flex gap-[5px]"
              />
            </fieldset>
          </div>

          <div className="flex flex-col gap-2">
            <span className="lbl text-label">{copy.thinksWith}</span>
            {runtimes.data && (
              <ProviderChoices
                runtimes={runtimes.data}
                draft={draft}
                onChange={setDraft}
                only={connected ?? []}
                markClassName="size-5 text-[13px]"
              />
            )}
            {ready.includes(draft.runtime) && (
              <ModelsBrain models={models} draft={draft} onChange={setDraft} waitingClassName="py-2" />
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
