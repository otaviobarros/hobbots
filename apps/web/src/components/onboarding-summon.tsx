import type { Agent, InstallationSetup } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../api/client.ts";
import { type FirstHobDraft, gearOf, keepDraft, reopenDraft, roleTitleOf, submitDraft } from "../api/first-hob.ts";
import { modelsQuery, useCreateHob } from "../api/queries.ts";
import { remoteAccessQuery } from "../api/remote-access.ts";
import { presetInfo } from "../api/safety.ts";
import { setupQuery, useUpdateSetup } from "../api/setup.ts";
import { motionReduced } from "../lib/motion.ts";
import { PROVIDER_NAMES } from "../lib/providers.ts";
import { FirstArrived, FirstSummoning } from "./first-arrived.tsx";
import { messages } from "./messages.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { builtPreview } from "./onboarding-preview.ts";
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
  const remoteOn = useQuery(remoteAccessQuery).data?.enabled ?? false;
  const failed = ritual === "idle" && (create.isError || update.isError);
  const problem = summonProblem(create.error, failed, name);

  return (
    <OnboardingFrame
      step={4}
      // The summoning and the arrival fill the whole width, as the scene they are.
      preview={ritual === "idle" ? builtPreview(setup.data, draft, 5, copy.guide({ name }), { remoteOn }) : undefined}
      footer={ritual === "idle" ? <ReadyFooter problem={problem} onBack={back} /> : null}
    >
      {ritual === "arrived" && hob ? (
        <FirstArrived hob={hob} onReplay={replay} />
      ) : ritual === "summoning" ? (
        <FirstSummoning hob={{ lookSeed: draft.lookSeed, lookColor: draft.lookColor, ...gearOf(draft) }} name={name} />
      ) : (
        <ReadyToSummon
          rows={readyRows(setup.data, draft, model?.displayName ?? "", remoteOn)}
          label={failed ? copy.tryAgain : copy.summon}
          disabled={!setup.data}
          onSummon={() => void summon()}
        />
      )}
    </OnboardingFrame>
  );
}

/** Ready's footer: why the last summon failed, if it did, and Back. */
function ReadyFooter({ problem, onBack }: { problem: string | undefined; onBack: () => void }) {
  return (
    <>
      <span role={problem ? "alert" : undefined} className="flex-1 text-sm text-rose">
        {problem}
      </span>
      <Button variant="outline" onClick={onBack}>
        {shared.back}
      </Button>
    </>
  );
}

const summonProblem = (error: Error | null, failed: boolean, name: string): string | undefined => {
  if (error instanceof ApiError && error.tag === "InvalidHob") return copy.rejected({ name, reason: error.message });
  return failed ? copy.failed({ name }) : undefined;
};

/** One line of Ready's summary: a step, what was picked there, and the step to change it. */
interface ReadyRow {
  readonly label: string;
  readonly value: string;
  readonly to: "/setup/providers" | "/setup/hob" | "/setup/safety" | "/setup/folders" | "/setup/remote";
}

const readyRows = (
  setup: InstallationSetup | undefined,
  draft: FirstHobDraft,
  model: string,
  remoteOn: boolean,
): ReadonlyArray<ReadyRow> => {
  const [ai, hob, safety, folders, devices] = shared.frame.summaryNames;
  const approved = setup?.approvedFolders ?? [];
  const title = roleTitleOf(draft);
  const name = draft.name.trim() || shared.frame.yourHob;
  return [
    {
      label: ai ?? "",
      value: [PROVIDER_NAMES[draft.runtime], model].filter(Boolean).join(" · "),
      to: "/setup/providers",
    },
    { label: hob ?? "", value: title ? `${name}, ${title.toLowerCase()}` : name, to: "/setup/hob" },
    { label: safety ?? "", value: setup ? presetInfo(setup.safetyPreset).label : "", to: "/setup/safety" },
    {
      label: folders ?? "",
      value: approved.length === 0 ? shared.frame.noFolders : approved.map(shortPath).join(", "),
      to: "/setup/folders",
    },
    { label: devices ?? "", value: remoteOn ? shared.frame.devicesOn : copy.devicesLater, to: "/setup/remote" },
  ];
};

/** A folder as Ready lists it, with the home folder as ~. */
const shortPath = (folder: string) => folder.replace(/^\/(?:Users|home)\/[^/]+/, "~");

/** Before the summon: everything picked, each with Change, and the circle to light. */
function ReadyToSummon({
  rows,
  label,
  disabled,
  onSummon,
}: {
  rows: ReadonlyArray<ReadyRow>;
  label: string;
  disabled: boolean;
  onSummon: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.heading}</h1>
        <p className="m-0 text-text-secondary">{copy.intro}</p>
      </div>
      <dl className="m-0 rounded-card bg-card px-4 py-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-3 border-line border-b py-2.5 last:border-b-0">
            <dt className="lbl w-[120px] flex-none text-label">{row.label}</dt>
            <dd className="m-0 min-w-0 flex-1 truncate">{row.value}</dd>
            <Button asChild variant="ghost" size="xs" className="text-link">
              <Link to={row.to} aria-label={copy.change({ step: row.label })}>
                {copy.changeShort}
              </Link>
            </Button>
          </div>
        ))}
      </dl>
      <div className="flex justify-center pt-2">
        <Button
          variant="outline"
          onClick={onSummon}
          disabled={disabled}
          className="h-[74px] w-[260px] max-w-full animate-hb-glow rounded-[50%] border-3 border-moonlight bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-moonlight)_18%,transparent),transparent)] text-[17px] font-bold text-text-strong [clip-path:none] shadow-[0_0_24px_var(--color-moonlight)] hover:bg-hover"
        >
          <span aria-hidden>✦</span>
          <span className="truncate">{label}</span>
        </Button>
      </div>
    </div>
  );
}
