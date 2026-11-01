import {
  isNarrowerOrEqual,
  type PolicyDecision,
  type PolicyOperation,
  type PolicyOverrides,
  PRESET_DECISIONS,
  ruleEnforcement,
  type SafetyPreset,
  type SandboxState,
} from "@hobbots/domain";

/**
 * The safety presets and rules as the Hobbots design words them (ADR 014). Each answer comes from
 * the policy's own preset table, so what onboarding and the profile show is what the hub enforces.
 */

export type RuleAnswer = "Allow" | "Ask" | "Never";

/** The UI says Never for the policy's Deny. */
export const ANSWER: Readonly<Record<PolicyDecision, RuleAnswer>> = { allow: "Allow", ask: "Ask", deny: "Never" };

export interface PresetInfo {
  readonly id: SafetyPreset;
  readonly label: string;
  readonly note: string;
  /** What the Elder Hob says when the user picks it. */
  readonly guide: string;
  readonly recommended: boolean;
  readonly rules: ReadonlyArray<readonly [string, RuleAnswer]>;
}

/** The rows onboarding's Safety step and Settings show for a preset, in order. */
const SUMMARY_ROWS: ReadonlyArray<readonly [string, PolicyOperation]> = [
  ["Read your folders", "read-files"],
  ["Create and edit files", "edit-files"],
  ["Delete files", "delete-files"],
  ["Run commands", "run-commands"],
  ["Use the web", "use-web"],
  ["Push your work", "push"],
  ["Anything outside your folders", "outside-folders"],
];

const summary = (preset: SafetyPreset) =>
  SUMMARY_ROWS.map(([label, operation]) => [label, ANSWER[PRESET_DECISIONS[preset][operation]]] as const);

export const PRESETS: ReadonlyArray<PresetInfo> = [
  {
    id: "careful",
    label: "Careful",
    note: "Reads freely and asks before changing anything. Good for your first week.",
    guide: "Careful it is. Your hobs read your folders on their own and ask before they change, run or fetch anything.",
    recommended: false,
    rules: summary("careful"),
  },
  {
    id: "balanced",
    label: "Balanced",
    note: "Works freely in your folders. Deleting and pushing wait for you.",
    guide:
      "Balanced is what most people pick. Your hobs edit, run and browse in your folders on their own, and ask before deleting or pushing.",
    recommended: true,
    rules: summary("balanced"),
  },
  {
    id: "trusting",
    label: "Trusting",
    note: "Gets on with chores and tells you after. Best for hobs you know well.",
    guide: "Trusting! Your hobs just get on with it, pushes included. They still stay inside your folders.",
    recommended: false,
    rules: summary("trusting"),
  },
];

export const presetInfo = (id: SafetyPreset): PresetInfo =>
  PRESETS.find((p) => p.id === id) ?? (PRESETS[1] as PresetInfo);

/** One rule of a hob's Permissions tab: what the operation covers, in the user's words. */
export interface RuleInfo {
  readonly operation: PolicyOperation;
  readonly label: string;
  readonly note: string;
  /** The answers the hub can give this rule; absent, Allow, Ask and Never. */
  readonly answers?: ReadonlyArray<PolicyDecision>;
}

/** Every operation the policy decides, in the order the Permissions tab lists them. */
export const RULES: ReadonlyArray<RuleInfo> = [
  { operation: "read-files", label: "Read files", note: "Reading and searching files in its folders." },
  { operation: "edit-files", label: "Create and edit files", note: "Writing, creating and renaming files." },
  { operation: "delete-files", label: "Delete files", note: "Removing files in its folders." },
  { operation: "run-commands", label: "Run commands", note: "Shell commands, tests and builds." },
  { operation: "local-git", label: "Local Git", note: "Status, diff, branches and commits on the hub." },
  { operation: "push", label: "Push your work", note: "Sending commits to a remote." },
  { operation: "use-web", label: "Use the web", note: "Fetching pages, package installs and downloads." },
  {
    operation: "read-github",
    label: "Read GitHub",
    note: "Repository details, issues and pull requests of its folders, read on the hub.",
    // A GitHub read cannot pause for an approval yet, so the hub offers no Ask (#317).
    answers: ["allow", "deny"],
  },
  {
    operation: "outside-folders",
    label: "Anything outside its folders",
    note: "Any other file on the hub. Always Never.",
  },
];

/**
 * The answer the hub gives a rule, among those it offers: an Ask a rule cannot give, as an override
 * saved through the API could hold, refuses every call, so it shows as Never.
 */
export const offeredAnswer = (operation: PolicyOperation, decision: PolicyDecision): PolicyDecision => {
  const offered = RULES.find((rule) => rule.operation === operation)?.answers;
  return offered === undefined || offered.includes(decision) ? decision : "deny";
};

/** The answers a hob may pick for a rule: the preset's own and every narrower one. */
export const answersWithin = (preset: PolicyDecision): ReadonlyArray<PolicyDecision> =>
  (["allow", "ask", "deny"] as const).filter((answer) => isNarrowerOrEqual(answer, preset));

/**
 * The overrides after picking `answer` for one rule. Picking the preset's own answer drops the
 * override, so the hob follows the preset again if it changes later.
 */
export const pickAnswer = (
  overrides: PolicyOverrides,
  operation: PolicyOperation,
  answer: PolicyDecision,
  preset: SafetyPreset,
): PolicyOverrides => {
  const { [operation]: _, ...rest } = overrides;
  return answer === PRESET_DECISIONS[preset][operation] ? rest : { ...rest, [operation]: answer };
};

/** Whether the rule is held by the sandbox or only checked by Hobbots, under these answers. */
export const enforcement = (
  operation: PolicyOperation,
  decisions: Readonly<Record<PolicyOperation, PolicyDecision>>,
  sandbox: SandboxState = "on",
) => ruleEnforcement(operation, (other) => decisions[other], sandbox);

/** The badge color for a rule's answer. */
export const ruleColor = (answer: RuleAnswer) =>
  answer === "Allow" ? "bg-mint" : answer === "Ask" ? "bg-lantern" : "bg-rose";

/** A folder's last part for its row; the root folder keeps its slash. */
export const folderName = (folder: string): string => {
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed === "" ? "/" : (trimmed.split("/").pop() ?? trimmed);
};

/** The list after adding a folder; one already there stays where it was. */
export const addFolder = (folders: ReadonlyArray<string>, folder: string): ReadonlyArray<string> =>
  folders.includes(folder) ? folders : [...folders, folder];

export const removeFolder = (folders: ReadonlyArray<string>, folder: string): ReadonlyArray<string> =>
  folders.filter((f) => f !== folder);

/** "No folders shared", "1 folder shared", "3 folders shared". */
export const foldersShared = (count: number) =>
  count === 0 ? "No folders shared" : `${count} ${count === 1 ? "folder" : "folders"} shared`;
