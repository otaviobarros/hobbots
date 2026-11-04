import type { InstallationSetup, SafetyPreset } from "@hobbots/domain";
import { type FirstHobDraft, gearOf, roleTitleOf } from "../../api/first-hob.ts";
import { presetInfo } from "../../api/safety.ts";
import { PROVIDER_NAMES } from "../../lib/providers.ts";
import { messages } from "../messages.ts";
import type { Preview, PreviewChip, SummaryLine } from "./onboarding-frame.tsx";

const copy = messages.onboarding.frame;

/** How far setup has come: the rows of the summary that are settled, Your AI first. */
export type SetupProgress = 0 | 1 | 2 | 3 | 4 | 5;

/** How high the preview's fence stands for each safety preset: Careful highest. */
const FENCE: Record<SafetyPreset, number> = { careful: 1, balanced: 0.6, trusting: 0.25 };

const fenceFor = (preset: SafetyPreset): number => FENCE[preset];

const foldersValue = (count: number) => (count === 0 ? copy.noFolders : copy.folders({ count }));

/** What setup has settled, row by row; a row past `progress` still reads as not yet. */
export const setupSummary = (
  progress: SetupProgress,
  setup: InstallationSetup | undefined,
  draft: FirstHobDraft | null,
  remoteOn = false,
): ReadonlyArray<SummaryLine> => {
  const names = (setup?.connectedProviders ?? []).map((runtime) => PROVIDER_NAMES[runtime]);
  const values = [
    names.length > 0 ? names.join(" · ") : null,
    draft ? hobValue(draft) : null,
    setup ? presetInfo(setup.safetyPreset).label : null,
    setup ? foldersValue(setup.approvedFolders.length) : null,
    remoteOn ? copy.devicesOn : copy.devicesLater,
  ];
  return copy.summaryNames.map((label, i) => ({ label, value: i < progress ? (values[i] ?? null) : null }));
};

const hobValue = (draft: FirstHobDraft) => {
  const name = draft.name.trim() || copy.yourHob;
  const title = roleTitleOf(draft);
  return title ? `${name} · ${title}` : name;
};

/** The AI tag over the preview's sky once a provider is connected. */
export const connectedChip = (setup: InstallationSetup | undefined): PreviewChip | undefined => {
  const first = setup?.connectedProviders[0];
  return first ? { label: PROVIDER_NAMES[first], tone: "connected" } : undefined;
};

/** The first hob as the preview shows it: its sprite, name and role title. */
export const previewHob = (draft: FirstHobDraft): NonNullable<Exclude<Preview["hob"], "ghost">> => ({
  lookSeed: draft.lookSeed,
  lookColor: draft.lookColor,
  ...gearOf(draft),
  sigil: draft.role ?? draft.ownSigil,
  name: draft.name.trim() || copy.yourHob,
  title: roleTitleOf(draft),
});

/**
 * The preview once the first hob has a shape: the AI tag, the hob, its fence and folders as far as
 * setup has come, the phone when other devices may connect, and the summary to `progress`.
 */
export const builtPreview = (
  setup: InstallationSetup | undefined,
  draft: FirstHobDraft,
  progress: SetupProgress,
  speech: string,
  { caption, remoteOn = false }: { caption?: string | undefined; remoteOn?: boolean } = {},
): Preview => ({
  chip: connectedChip(setup),
  hob: previewHob(draft),
  fence: setup && progress >= 2 ? fenceFor(setup.safetyPreset) : 0,
  folders: progress >= 3 ? (setup?.approvedFolders.length ?? 0) : 0,
  phone: remoteOn,
  caption,
  speech,
  summary: setupSummary(progress, setup, draft, remoteOn),
});
