import type { Agent, InstallationSetup } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../api/client.ts";
import { type FirstHobDraft, gearOf, hobLine, keepDraft, reopenDraft, submitDraft } from "../api/first-hob.ts";
import { modelsQuery, useCreateHob } from "../api/queries.ts";
import { foldersShared, presetInfo } from "../api/safety.ts";
import { setupQuery, useUpdateSetup } from "../api/setup.ts";
import { motionReduced } from "../lib/motion.ts";
import { connectedLines, PROVIDER_NAMES } from "../lib/providers.ts";
import { FirstArrived, FirstSummoning } from "./first-arrived.tsx";
import { HobSprite } from "./hob-sprite.tsx";
import { messages } from "./messages.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { useFirstHobDraft } from "./onboarding-safety.tsx";
import { summoningLeft } from "./summon/summon-model.ts";
import { SUMMONING_MS } from "./summon/summoning.tsx";

const shared = messages.onboarding;
const copy = messages.onboarding.ready;

/** idle → summoning (the circle plays while the hub creates the hob) → arrived, with a replay. */
type Ritual = "idle" | "summoning" | "arrived";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Onboarding step 5: the summon. It creates the first hob from the draft and marks setup complete
 * while the Chief calls it in, then shows the hob beside the Chief with its chat and Home one click
 * away. Under Reduce motion the scene skips straight to the arrival once the hob exists.
 */
export function OnboardingReady() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const setup = useQuery(setupQuery);
  const create = useCreateHob();
  const update = useUpdateSetup();
  const [draft, setDraft] = useState<FirstHobDraft>(useFirstHobDraft());
  const models = useQuery(modelsQuery(draft.runtime));
  const [ritual, setRitual] = useState<Ritual>("idle");
  const [hob, setHob] = useState<Agent | null>(null);

  const summon = async () => {
    if (ritual !== "idle") return;
    setRitual("summoning");
    const startedAt = Date.now();
    // Once sent, the hob may exist even when no answer comes back, so the draft locks and every
    // retry repeats the same request; the hub returns the hob it made the first time.
    const sent = submitDraft(draft);
    setDraft(sent);
    keepDraft(sent);
    try {
      const made = await create.mutateAsync(sent.submitted);
      await update.mutateAsync({ completed: true });
      keepDraft(null);
      setHob(made);
      await wait(summoningLeft(startedAt, Date.now(), SUMMONING_MS, motionReduced()));
      setRitual("arrived");
    } catch (error) {
      if (error instanceof ApiError && error.tag === "InvalidHob") {
        const reopened = reopenDraft(sent);
        setDraft(reopened);
        keepDraft(reopened);
      }
      setRitual("idle");
    }
  };
  const replay = () => {
    setRitual("summoning");
    void wait(motionReduced() ? 0 : SUMMONING_MS).then(() => setRitual("arrived"));
  };

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/remote" }));
  const name = draft.name.trim() || shared.firstHob.yourHob;
  const model = models.data?.models.find((m) => m.id === draft.model);
  const failed = ritual === "idle" && (create.isError || update.isError);
  const problem = summonProblem(create.error, failed, name);

  return (
    <OnboardingFrame
      step={4}
      guide={ritual === "arrived" ? copy.doneGuide : copy.guide}
      sofar={soFar(setup.data, draft)}
      footer={
        ritual === "idle" ? (
          <>
            <Button variant="outline" onClick={back}>
              {shared.back}
            </Button>
            <span role={problem ? "alert" : undefined} className="flex-1 text-right text-sm text-rose">
              {problem}
            </span>
          </>
        ) : null
      }
    >
      {ritual === "arrived" && hob ? (
        <FirstArrived hob={hob} onReplay={replay} />
      ) : ritual === "summoning" ? (
        <FirstSummoning hob={{ lookSeed: draft.lookSeed, lookColor: draft.lookColor, ...gearOf(draft) }} name={name} />
      ) : (
        <ReadyToSummon
          draft={draft}
          model={model?.displayName ?? ""}
          label={failed ? copy.tryAgain : copy.summon({ name })}
          disabled={!setup.data}
          onSummon={() => void summon()}
        />
      )}
    </OnboardingFrame>
  );
}

const summonProblem = (error: Error | null, failed: boolean, name: string): string | undefined => {
  if (error instanceof ApiError && error.tag === "InvalidHob") return copy.rejected({ name, reason: error.message });
  return failed ? copy.failed({ name }) : undefined;
};

/** Before the summon: who is coming and what it thinks with, and the circle to light. */
function ReadyToSummon({
  draft,
  model,
  label,
  disabled,
  onSummon,
}: {
  draft: FirstHobDraft;
  model: string;
  label: string;
  disabled: boolean;
  onSummon: () => void;
}) {
  return (
    <div className="flex animate-hb-in flex-col items-center gap-2.5 pt-1 text-center">
      <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.heading}</h1>
      <p className="m-0 max-w-full text-text-secondary break-words">
        {copy
          .thinksWith({
            hob: hobLine(draft),
            provider: PROVIDER_NAMES[draft.runtime],
            model,
          })
          .trim()}
      </p>
      <div className="my-6">
        <HobSprite hob={{ lookSeed: draft.lookSeed, lookColor: draft.lookColor, ...gearOf(draft) }} size={96} />
      </div>
      <Button
        variant="outline"
        onClick={onSummon}
        disabled={disabled}
        className="h-[74px] w-[260px] max-w-full rounded-[50%] border-3 border-moonlight bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-moonlight)_18%,transparent),transparent)] text-[17px] font-bold text-text-strong [clip-path:none] shadow-[0_0_24px_var(--color-moonlight)] hover:bg-hover"
      >
        <span aria-hidden>✦</span>
        <span className="truncate">{label}</span>
      </Button>
    </div>
  );
}

/** What setup has settled so far, for the guide beside the step. */
export const soFar = (setup: InstallationSetup | undefined, draft: FirstHobDraft): ReadonlyArray<string> => [
  ...connectedLines(setup?.connectedProviders),
  shared.hobOn({ hob: hobLine(draft), provider: PROVIDER_NAMES[draft.runtime] }),
  ...(setup
    ? [
        shared.presetSafety({ preset: presetInfo(setup.safetyPreset).label }),
        foldersShared(setup.approvedFolders.length),
      ]
    : []),
];
