import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type FirstHobDraft, hobLine, keptDraftOrStored, restoreDraft } from "../api/first-hob.ts";
import { foldersShared, presetInfo } from "../api/safety.ts";
import { setupQuery, useSavingSetup } from "../api/setup.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { FolderPicker, PresetPicker } from "./safety-and-folders.tsx";

const SAFETY_GUIDE = "A good hob always asks before doing something you cannot undo. How careful should yours be?";
const FOLDERS_GUIDE = "Pick the folders your hobs share. You can give one hob more of its own later, from its profile.";

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
  const [guide, setGuide] = useState(SAFETY_GUIDE);
  const name = draft.name.trim() || "your hob";

  return (
    <OnboardingFrame
      step={2}
      guide={guide}
      sofar={["Claude connected", `${hobLine(draft)} on Claude`]}
      footer={
        <>
          <Button variant="outline" onClick={back} disabled={saving}>
            Back
          </Button>
          <span className="flex-1" />
          <Button onClick={() => void navigate({ to: "/setup/folders" })} disabled={!setup.data || saving}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-pixel text-[30px] font-bold text-moonlight">How much should {name} ask first?</h1>
        <p className="m-0 mb-3.5 text-secondary-text">
          Hobs read, edit, run and browse inside the folders you pick next. Pick how often they ask you first.
        </p>
        {setup.data ? (
          <PresetPicker
            label="Safety preset"
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
      guide={FOLDERS_GUIDE}
      sofar={[
        "Claude connected",
        `${hobLine(draft)} on Claude`,
        ...(setup.data ? [`${presetInfo(setup.data.safetyPreset).label} safety`] : []),
      ]}
      footer={
        <>
          <Button variant="outline" onClick={back} disabled={saving}>
            Back
          </Button>
          <span className="flex-1 text-right text-sm text-secondary-text">
            {folders.length === 0 ? "No folders is fine, hobs can still chat" : foldersShared(folders.length)}
          </span>
          <Button onClick={() => void navigate({ to: "/setup/ready" })} disabled={!setup.data || saving}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex max-w-[780px] animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-pixel text-[30px] font-bold text-moonlight">Where can hobs work?</h1>
        <p className="m-0 mb-2.5 text-secondary-text">
          Every hob can work in these folders, and nowhere else on this computer. You can give one hob more folders of
          its own from its profile.
        </p>
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
      Hobbots could not read your setup.
      <Button variant="outline" size="xs" onClick={onRetry}>
        Try again
      </Button>
    </p>
  );
}
