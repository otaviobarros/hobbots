import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type FirstHobDraft, hobLine, keptDraftOrStored, restoreDraft } from "../api/first-hob.ts";
import { foldersShared, presetInfo } from "../api/safety.ts";
import { setupQuery, useSavingSetup } from "../api/setup.ts";
import { connectedLines, PROVIDER_NAMES } from "../lib/providers.ts";
import { messages } from "./messages.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { FolderPicker, PresetPicker } from "./safety-and-folders.tsx";

const shared = messages.onboarding;

/** The first hob as chosen on the step before, read back from storage. */
export const useFirstHobDraft = (): FirstHobDraft => {
  const [draft] = useState(() => restoreDraft(keptDraftOrStored()));
  return draft;
};

function useBack(fallback: "/setup/hob" | "/setup/safety" | "/setup/folders") {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return () => (canGoBack ? router.history.back() : void navigate({ to: fallback }));
}

/** Onboarding step 3: how much the hobs ask first. Balanced, Trusted Workspace, is preselected. */
export function OnboardingSafety() {
  const navigate = useNavigate();
  const back = useBack("/setup/hob");
  const draft = useFirstHobDraft();
  const setup = useQuery(setupQuery);
  const saving = useSavingSetup();
  const [guide, setGuide] = useState<string>(shared.safety.guide);
  const name = draft.name.trim() || shared.firstHob.yourHob;

  return (
    <OnboardingFrame
      step={2}
      guide={guide}
      sofar={[
        ...connectedLines(setup.data?.connectedProviders),
        shared.hobOn({ hob: hobLine(draft), provider: PROVIDER_NAMES[draft.runtime] }),
      ]}
      footer={
        <>
          <Button variant="outline" onClick={back} disabled={saving}>
            {shared.back}
          </Button>
          <span className="flex-1" />
          <Button onClick={() => void navigate({ to: "/setup/folders" })} disabled={!setup.data || saving}>
            {shared.continue}
          </Button>
        </>
      }
    >
      <div className="flex animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{shared.safety.heading({ name })}</h1>
        <p className="m-0 mb-3.5 text-text-secondary">{shared.safety.intro}</p>
        {setup.data ? (
          <PresetPicker
            label={shared.safety.preset}
            value={setup.data.safetyPreset}
            onPicked={(preset) => setGuide(presetInfo(preset).guide)}
          />
        ) : setup.isError ? (
          <SetupUnread onRetry={() => void setup.refetch()} />
        ) : null}
      </div>
    </OnboardingFrame>
  );
}

/** Onboarding step 4: the folders hobs may work in. None is fine; hobs can still chat. */
export function OnboardingFolders() {
  const navigate = useNavigate();
  const back = useBack("/setup/safety");
  const draft = useFirstHobDraft();
  const setup = useQuery(setupQuery);
  const saving = useSavingSetup();
  const folders = setup.data?.approvedFolders ?? [];

  return (
    <OnboardingFrame
      step={3}
      guide={shared.folders.guide}
      sofar={[
        ...connectedLines(setup.data?.connectedProviders),
        shared.hobOn({ hob: hobLine(draft), provider: PROVIDER_NAMES[draft.runtime] }),
        ...(setup.data ? [shared.presetSafety({ preset: presetInfo(setup.data.safetyPreset).label })] : []),
      ]}
      footer={
        <>
          <Button variant="outline" onClick={back} disabled={saving}>
            {shared.back}
          </Button>
          <span className="flex-1 text-right text-sm text-text-secondary">
            {folders.length === 0 ? shared.folders.none : foldersShared(folders.length)}
          </span>
          <Button onClick={() => void navigate({ to: "/setup/ready" })} disabled={!setup.data || saving}>
            {shared.continue}
          </Button>
        </>
      }
    >
      <div className="flex max-w-[780px] animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{shared.folders.heading}</h1>
        <p className="m-0 mb-2.5 text-text-secondary">{shared.folders.intro}</p>
        {setup.data ? (
          <FolderPicker folders={folders} />
        ) : setup.isError ? (
          <SetupUnread onRetry={() => void setup.refetch()} />
        ) : null}
      </div>
    </OnboardingFrame>
  );
}

function SetupUnread({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-3 text-sm text-rose">
      {messages.setup.failed}
      <Button variant="outline" size="xs" onClick={onRetry}>
        {messages.setup.retry}
      </Button>
    </p>
  );
}
