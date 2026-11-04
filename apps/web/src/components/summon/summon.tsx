import type { RuntimeHealth } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Stepper } from "@hobbots/ui/components/stepper";
import { focusElement } from "@hobbots/ui/lib/restore-focus";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import {
  type FirstHobDraft,
  gearOf,
  keepSummonDraft,
  keptSummonDraft,
  reopenDraft,
  settleSummonDraft,
  submitDraft,
} from "../../api/first-hob.ts";
import { agentsQuery, modelsQuery, runtimesQuery, useCreateHob } from "../../api/queries.ts";
import { signInProblem } from "../../api/runtime-health.ts";
import { presetInfo } from "../../api/safety.ts";
import { setupQuery } from "../../api/setup.ts";
import { openSummonDraft, summonProblem } from "../../api/summon.ts";
import { motionReduced } from "../../lib/motion.ts";
import { readyProviders } from "../../lib/providers.ts";
import { useSettledBrain, useSettledRuntime } from "../hob-form/hob-form.tsx";
import { messages as shared } from "../messages.ts";
import { LookStep } from "./look-step.tsx";
import { messages } from "./messages.ts";
import { ReadyStep } from "./ready-step.tsx";
import { RoleStep } from "./role-step.tsx";
import { roleProblem, type SummonStep, stepAt, stepIndex, summoningLeft } from "./summon-model.ts";
import { SummonPreview } from "./summon-preview.tsx";
import { SUMMONING_MS, Summoning } from "./summoning.tsx";

const copy = messages;

/**
 * Summon a hob, after onboarding, in three steps: what it helps with, its name and look, then a
 * plain summary with the AI it thinks with. A live preview follows every choice. The step lives in
 * the address, so Back and a reload keep it; the draft is kept until the hob exists. The summon
 * plays the summoning while the hub makes the hob, then shows it on the Arrived screen.
 */
export function Summon({ step, onStep }: { step: SummonStep; onStep: (step: SummonStep) => void }) {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const hobs = useQuery(agentsQuery);
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const create = useCreateHob();
  // The route loads the hob list first, so a fresh name avoids the hobs the user already has and a
  // draft whose hob already joined is not brought back.
  const [draft, setDraft] = useState<FirstHobDraft>(() => openSummonDraft(keptSummonDraft(), hobs.data ?? []));
  const models = useQuery(modelsQuery(draft.runtime));
  const [tried, setTried] = useState(false);
  const { left, summon, summoning } = useSummonHob(draft, setDraft, create);
  const { scroller, heading } = useStepStart(step);

  // Leaving and coming back keeps what was chosen, until the hob exists.
  useEffect(() => keepSummonDraft(draft), [draft]);
  useSettledRuntime(readyProviders(runtimes.data), setDraft);
  useSettledBrain(models.data, setDraft);

  const index = stepIndex(step);
  const last = index === 2;
  const locked = draft.submitted !== null;
  const name = draft.name.trim() || shared.onboarding.firstHob.yourHob;
  const health = runtimes.data?.find((r) => r.runtime === draft.runtime);
  // The AI it would think with is signed out: Ready leads with how to fix it.
  const signedOut = signedOutHealth(health);
  const model = models.data?.models.find((m) => m.id === draft.model);
  const rejected = create.error instanceof ApiError && create.error.tag === "InvalidHob" ? create.error : undefined;
  const problem = summonProblem(
    draft,
    { pending: runtimes.isPending, failed: runtimes.isError, health },
    model !== undefined,
  );
  const stepProblem = index === 0 ? roleProblem(draft) : undefined;
  const hint = summonHint({ create, rejected, name, problem: last ? problem : stepProblem });
  const blocked = last ? problem !== undefined || create.isPending : stepProblem !== undefined;

  // Cancel drops the draft; leaving any other way keeps it for next time.
  const cancel = () => {
    left.current = true;
    if (!locked) keepSummonDraft(null);
    if (canGoBack) router.history.back();
    else void navigate({ to: "/hobs" });
  };
  const next = (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (blocked) return;
    setTried(false);
    if (last) void summon();
    else onStep(stepAt(index + 1));
  };

  if (summoning)
    return (
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <Summoning hob={{ lookSeed: draft.lookSeed, lookColor: draft.lookColor, ...gearOf(draft) }} name={name} />
      </main>
    );

  return (
    <main ref={scroller} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <form onSubmit={next} className="mx-auto flex w-full max-w-[1064px] flex-col gap-6 px-8 py-8">
        <header className="flex flex-col gap-3.5">
          <div className="flex items-center gap-4">
            <h1 className="lbl m-0 flex-1 text-label">{copy.heading}</h1>
            <Button type="button" variant="ghost" size="sm" onClick={cancel} className="text-text-secondary">
              {copy.cancel}
            </Button>
          </div>
          <Stepper
            aria-label={copy.stepsLabel}
            doneLabel={copy.stepDone}
            steps={copy.steps}
            current={index}
            onPick={locked ? undefined : (i) => onStep(stepAt(i))}
          />
        </header>

        <div className="flex items-start gap-8 max-[1120px]:flex-col">
          <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-[18px] max-[1120px]:w-full">
            {/* The choices are disabled once sent: the hob may already exist with exactly these. */}
            <fieldset
              disabled={locked}
              className="m-0 flex min-w-0 flex-col gap-[18px] border-0 p-0 disabled:opacity-85"
            >
              <legend className="sr-only">{copy.steps[index]}</legend>
              <div className="flex flex-col gap-1">
                <h2 ref={heading} className="m-0 font-heading text-[26px] leading-8 font-(--heading-weight)">
                  {stepTitle(step, name, signedOut !== undefined)}
                </h2>
                <span className="text-text-secondary">{stepIntro(step, name)}</span>
              </div>
              <div key={step} className="animate-hb-in">
                <StepBody
                  step={step}
                  draft={draft}
                  onChange={setDraft}
                  name={name}
                  preset={setup.data && presetInfo(setup.data.safetyPreset)}
                  runtimes={runtimes}
                  signedOut={signedOut}
                  models={models}
                  onStep={onStep}
                />
              </div>
            </fieldset>
            <SummonFooter
              index={index}
              name={name}
              locked={locked}
              blocked={blocked}
              warn={blocked && tried}
              failed={create.isError}
              hint={hint}
              onBack={() => onStep(stepAt(index - 1))}
            />
          </div>
          <SummonPreview draft={draft} name={name} last={last} />
        </div>
      </form>
    </main>
  );
}

const stepTitle = (step: SummonStep, name: string, blocked: boolean) => {
  if (step === "role") return copy.role.title;
  if (step === "look") return copy.look.title({ name });
  return blocked ? copy.ready.blockedTitle({ name }) : copy.ready.title({ name });
};

const stepIntro = (step: SummonStep, name: string) =>
  step === "role" ? copy.role.intro : step === "look" ? copy.look.intro : copy.ready.intro({ name });

type Create = ReturnType<typeof useCreateHob>;

/**
 * A new step starts at its top, with focus on its heading (WCAG 2.4.3), not at the step before's
 * scroll offset with its heading out of sight. The first step opens as the page does.
 */
function useStepStart(step: SummonStep) {
  const scroller = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    scroller.current?.scrollTo({ top: 0 });
    if (heading.current) focusElement(heading.current, { preventScroll: true });
  }, [step]);
  return { scroller, heading };
}

const summonHint = ({
  create,
  rejected,
  name,
  problem,
}: {
  create: Create;
  rejected: ApiError | undefined;
  name: string;
  problem: string | undefined;
}) => {
  if (create.isPending) return shared.summon.summoning({ name });
  if (rejected) return shared.summon.rejected({ name, reason: rejected.message });
  if (create.isError) return shared.onboarding.ready.failed({ name });
  return problem;
};

/** Sends the draft once, and opens the new hob's chat unless the user already left. */
function useSummonHob(
  draft: FirstHobDraft,
  setDraft: React.Dispatch<React.SetStateAction<FirstHobDraft>>,
  create: Create,
) {
  const navigate = useNavigate();
  const [summoning, setSummoning] = useState(false);
  // A summon that finishes after the user left only joins the hob list; it does not pull them back.
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);
  const summon = async () => {
    // Once sent, the hob may exist even when no answer comes back, so the choices lock and a
    // retry repeats the same request; the hub returns the hob it made the first time.
    const sent = submitDraft(draft);
    setDraft(sent);
    setSummoning(true);
    const startedAt = Date.now();
    try {
      const made = await create.mutateAsync(sent.submitted);
      // The hob exists, so the next Summon starts fresh, even when the user already left. A newer
      // draft started meanwhile belongs to another hob and stays.
      settleSummonDraft(sent.id, null);
      // The circle plays out before the hob is shown, unless motion is reduced.
      await wait(summoningLeft(startedAt, Date.now(), SUMMONING_MS, motionReduced()));
      if (!left.current) void navigate({ to: "/hobs/$hobId/arrived", params: { hobId: made.id }, replace: true });
    } catch (error) {
      setSummoning(false);
      if (error instanceof ApiError && error.tag === "InvalidHob") {
        const reopened = reopenDraft(sent);
        setDraft(reopened);
        settleSummonDraft(sent.id, reopened);
      }
    }
  };
  return { left, summon, summoning };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function StepBody({
  step,
  onStep,
  ...props
}: { step: SummonStep; onStep: (step: SummonStep) => void } & Omit<React.ComponentProps<typeof ReadyStep>, "onGo">) {
  if (step === "role") return <RoleStep draft={props.draft} onChange={props.onChange} name={props.name} />;
  if (step === "look") return <LookStep draft={props.draft} onChange={props.onChange} name={props.name} />;
  return <ReadyStep {...props} onGo={onStep} />;
}

function SummonFooter({
  index,
  name,
  locked,
  blocked,
  warn,
  failed,
  hint,
  onBack,
}: {
  index: number;
  name: string;
  locked: boolean;
  blocked: boolean;
  warn: boolean;
  failed: boolean;
  hint: string | undefined;
  onBack: () => void;
}) {
  const last = index === 2;
  return (
    <footer className="flex flex-wrap items-center gap-2">
      {index > 0 && (
        <Button type="button" variant="outline" onClick={onBack} disabled={locked}>
          {copy.back}
        </Button>
      )}
      <Button
        type="submit"
        aria-disabled={blocked}
        aria-describedby="summon-hint"
        className={cn(blocked && "opacity-50")}
      >
        {last && <span aria-hidden>✦</span>}
        {last ? copy.ready.summon({ name }) : index === 0 ? copy.role.next : copy.look.next}
      </Button>
      <span
        id="summon-hint"
        role={failed ? "alert" : undefined}
        className={cn("min-h-5 text-ui", failed ? "text-rose" : warn ? "text-lantern" : "text-text-secondary")}
      >
        {hint}
      </span>
    </footer>
  );
}

const signedOutHealth = (health: RuntimeHealth | undefined): RuntimeHealth | undefined =>
  signInProblem(health) === null ? undefined : health;
