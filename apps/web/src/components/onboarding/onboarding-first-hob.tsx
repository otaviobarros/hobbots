import { RUNTIME_NAMES, type RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  draftProblem,
  type FirstHobDraft,
  keepDraft,
  keptDraftOrStored,
  restoreDraft,
  roleTitleOf,
} from "../../api/first-hob.ts";
import { modelsQuery, runtimesQuery } from "../../api/queries.ts";
import { setupQuery } from "../../api/setup.ts";
import { readyProviders } from "../../lib/providers.ts";
import { useSettledBrain, useSettledRuntime } from "../hob-form/hob-form.tsx";
import { messages } from "../messages.ts";
import { messages as summonCopy } from "../summon/messages.ts";
import { Colors, Looks, NameField } from "../summon/name-and-look.tsx";
import { RoleCards } from "../summon/role-step.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { connectedChip, previewHob, setupSummary } from "./onboarding-preview.ts";

const shared = messages.onboarding;
const copy = messages.onboarding.firstHob;

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
 * Onboarding step 2: the user picks who helps them first, from Summon's pieces: the eight common
 * roles with See all, then a name from the dice, five looks and six colors. Hat, tool and voice come
 * from the role, and the hob thinks with the AI connected in the step before, on its default model
 * and effort; all of it can change later in the hob's profile. The summon at the end creates it.
 */
export function OnboardingFirstHob() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const connected = setup.data?.connectedProviders;
  const [draft, setDraft] = useState<FirstHobDraft>(() => restoreDraft(keptDraftOrStored()));
  const [tried, setTried] = useState(false);
  const models = useQuery(modelsQuery(draft.runtime));

  // Coming back to this step keeps what was chosen; a model the runtime dropped falls back,
  // unless the hob was already sent with it.
  useEffect(() => keepDraft(draft), [draft]);
  // The first hob thinks with a provider the user connected in the step before.
  const ready = readyProviders(runtimes.data, connected ?? []);
  useSettledRuntime(ready, setDraft);
  useSettledBrain(models.data, setDraft);

  const modelFound = models.data?.models.some((m) => m.id === draft.model) ?? false;
  const locked = draft.submitted !== null;
  const problem = locked ? undefined : firstHobProblem(draft, runtimes.isPending || setup.isPending, ready, modelFound);
  const name = draft.name.trim() || copy.yourHob;

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/providers" }));
  // The draft waits in storage; the summon at the end of setup creates the hob.
  const next = () => {
    setTried(true);
    if (problem) return;
    void navigate({ to: "/setup/safety" });
  };

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
            className={cn("flex-1 text-ui", problem && tried ? "text-lantern" : "text-text-secondary")}
          >
            {firstHobHint(draft, problem)}
          </span>
          <Button variant="outline" onClick={back}>
            {shared.back}
          </Button>
          <Button
            onClick={next}
            aria-disabled={problem !== undefined}
            aria-describedby="first-hob-hint"
            className={cn(problem && "opacity-50")}
          >
            {shared.continue}
          </Button>
        </>
      }
    >
      {/* Disabled once sent: the hob may already exist with exactly these choices. */}
      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0 disabled:opacity-85">
        <legend className="sr-only">{locked ? copy.legendSent({ name: draft.name.trim() }) : copy.legend}</legend>
        <div className="flex flex-col gap-1">
          <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.heading}</h1>
          <p className="m-0 text-text-secondary">{copy.intro}</p>
        </div>

        <RoleCards draft={draft} onChange={setDraft} name={name} />

        <div className="flex flex-col gap-3.5 rounded-card bg-card p-4">
          <NameField draft={draft} onChange={setDraft} />
          <div className="flex flex-col gap-2">
            <span aria-hidden className="lbl text-label">
              {summonCopy.look.look}
            </span>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
              <Looks draft={draft} onChange={setDraft} />
              <Colors value={draft.lookColor} onPick={(lookColor) => setDraft((d) => ({ ...d, lookColor }))} />
            </div>
          </div>
        </div>
        <span className="text-detail text-text-secondary">{copy.fromRole}</span>
      </fieldset>
    </OnboardingFrame>
  );
}
