import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type FirstHobDraft, keptDraftOrStored, restoreDraft } from "../../api/first-hob.ts";
import { foldersShared, presetInfo } from "../../api/safety.ts";
import { setupQuery, useSavingSetup } from "../../api/setup.ts";
import { messages } from "../messages.ts";
import { FolderPicker, PresetPicker } from "../safety/safety-and-folders.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { builtPreview } from "./onboarding-preview.ts";

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

  return (
    <OnboardingFrame
      step={2}
      preview={builtPreview(setup.data, draft, 2, guide, {
        caption: setup.data && presetInfo(setup.data.safetyPreset).brief,
      })}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="outline" onClick={back} disabled={saving}>
            {shared.back}
          </Button>
          <Button onClick={() => void navigate({ to: "/setup/folders" })} disabled={!setup.data || saving}>
            {shared.continue}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{shared.safety.heading}</h1>
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
      preview={builtPreview(setup.data, draft, 3, shared.folders.guide, {
        caption: folders.length === 0 ? shared.folders.none : foldersShared(folders.length),
      })}
      footer={
        <>
          <span className="flex-1 text-ui text-text-secondary">
            {folders.length === 0 ? shared.folders.none : foldersShared(folders.length)}
          </span>
          <Button variant="outline" onClick={back} disabled={saving}>
            {shared.back}
          </Button>
          <Button onClick={() => void navigate({ to: "/setup/remote" })} disabled={!setup.data || saving}>
            {shared.continue}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
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
    <p role="alert" className="m-0 flex items-center gap-3 text-ui text-rose">
      {messages.setup.failed}
      <Button variant="outline" size="xs" onClick={onRetry}>
        {messages.setup.retry}
      </Button>
    </p>
  );
}
