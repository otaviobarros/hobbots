import type { HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import {
  type AnyOperation,
  isCharmOperation,
  isNarrowerOrEqual,
  type PolicyDecision,
  type PolicyOperation,
  PRESET_DECISIONS,
  ruleEnforcement,
  type SafetyPreset,
  type SandboxState,
  trimTrailingSlashes,
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
  /** What the preset does, in one line, on first run's Safety step. */
  readonly brief: string;
  /** Who the preset suits, under the brief on first run's Safety step. */
  readonly who: string;
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
    brief: "Asks before changing anything.",
    who: "For trying Hobbots out, or for folders you care a lot about.",
    guide: "Careful it is. Your hobs read your folders on their own and ask before they change, run or fetch anything.",
    recommended: false,
    rules: summary("careful"),
  },
  {
    id: "balanced",
    label: "Balanced",
    note: "Works freely in your folders. Deleting and pushing wait for you.",
    brief: "Works on its own in its folders. Asks before deleting or pushing.",
    who: "Most people pick this.",
    guide:
      "Balanced is what most people pick. Your hobs edit, run and browse in your folders on their own, and ask before deleting or pushing.",
    recommended: true,
    rules: summary("balanced"),
  },
  {
    id: "trusting",
    label: "Trusting",
    note: "Gets on with chores and tells you after. Best for hobs you know well.",
    brief: "Does almost everything without asking.",
    who: "For people who check the work afterwards.",
    guide: "Trusting! Your hobs just get on with it, pushes included. They still stay inside your folders.",
    recommended: false,
    rules: summary("trusting"),
  },
];

export const presetInfo = (id: SafetyPreset): PresetInfo =>
  PRESETS.find((p) => p.id === id) ?? (PRESETS[1] as PresetInfo);

/** One rule of a hob's Permissions tab: what the operation covers, in the user's words. */
export interface RuleInfo {
  readonly operation: AnyOperation;
  readonly label: string;
  readonly note: string;
  /** The answers the hub can give this rule; absent, Allow, Ask and Never. */
  readonly answers?: ReadonlyArray<PolicyDecision>;
}

/** Every operation the policy decides, in the order the Permissions tab lists them. */
export const RULES: ReadonlyArray<RuleInfo> = [
  { operation: "read-files", label: "Look at files", note: "Reading and searching files in its folders." },
  { operation: "edit-files", label: "Change files", note: "Writing, creating and renaming files." },
  { operation: "delete-files", label: "Delete files", note: "Removing files in its folders." },
  { operation: "run-commands", label: "Run commands and tests", note: "Shell commands, tests and builds." },
  { operation: "local-git", label: "Save versions with Git", note: "Status, diff, branches and commits on the hub." },
  { operation: "push", label: "Push your work", note: "Sending commits to a remote." },
  { operation: "use-web", label: "Use the web", note: "Fetching pages, package installs and downloads." },
  {
    operation: "github.read",
    label: "Read GitHub",
    note: "Repository details, issues and pull requests of its folders, read on the hub.",
    // Asking before a read would interrupt without protecting anything, so the hub offers no Ask (ADR 020).
    answers: ["allow", "deny"],
  },
  {
    operation: "github.open-pull-request",
    label: "Open pull requests",
    note: "Pull requests from its pushed branches, in the repository of its folders.",
  },
  {
    operation: "github.comment",
    label: "Comment on GitHub",
    note: "Comments on issues and pull requests in the repository of its folders.",
  },
  {
    operation: "outside-folders",
    label: "Anything outside its folders",
    note: "Any other file on the hub. Always Never.",
  },
  {
    operation: "search-memory",
    label: "Recall what it learned",
    note: "Search its own memory, About you and the projects it works in.",
  },
  {
    operation: "save-memory",
    label: "Remember things",
    note: "Save notes to its own memory. You see a line in the chat each time.",
  },
  {
    operation: "search-skills",
    label: "Look through your skills",
    note: "Search the names and descriptions in your library, to find one to ask for.",
  },
  {
    operation: "request-skill",
    label: "Ask for a skill",
    note: "Ask for a skill already in your library. Under Trusting it goes through, with Undo.",
  },
  {
    operation: "propose-skill",
    label: "Suggest a new skill or a change",
    note: "Draft a skill, or a change to one it uses. New content always waits for you.",
  },
  {
    operation: "skill-feedback",
    label: "Report a skill problem",
    note: "Note that a skill is wrong, outdated or unclear. You see the notes on the skill.",
  },
];

/** The operations the GitHub Charm card sets, in its order. Permissions lists the others. */
export const GITHUB_OPERATIONS = [
  "github.read",
  "push",
  "github.open-pull-request",
  "github.comment",
] as const satisfies ReadonlyArray<AnyOperation>;

const isGitHub = (operation: AnyOperation) => (GITHUB_OPERATIONS as ReadonlyArray<AnyOperation>).includes(operation);

/** The rules the Permissions tab lists: every rule but the GitHub Charm's. */
export const PERMISSION_RULES: ReadonlyArray<RuleInfo> = RULES.filter((rule) => !isGitHub(rule.operation));

/**
 * The answer the hub gives a rule, among those it offers: an Ask a rule cannot give, as an override
 * saved through the API could hold, refuses every call, so it shows as Never.
 */
export const offeredAnswer = (operation: AnyOperation, decision: PolicyDecision | undefined): PolicyDecision => {
  if (decision === undefined) return "deny";
  const offered = RULES.find((rule) => rule.operation === operation)?.answers;
  return offered === undefined || offered.includes(decision) ? decision : "deny";
};

/** The answers a hob may pick for a rule: the preset's own and every narrower one. */
export const answersWithin = (preset: PolicyDecision): ReadonlyArray<PolicyDecision> =>
  (["allow", "ask", "deny"] as const).filter((answer) => isNarrowerOrEqual(answer, preset));

/**
 * The preset's own answer for an operation, built-in or a Charm's, which the hub reports with the
 * hob's permissions. One the hub does not report is never allowed.
 */
export const presetAnswer = (permissions: HobPermissions, operation: AnyOperation): PolicyDecision =>
  permissions.presets[operation] ??
  (isCharmOperation(operation) ? "deny" : PRESET_DECISIONS[permissions.preset][operation]);

/**
 * The change after picking `answer` for one rule: the hob's built-in overrides, or its Charm
 * overrides for a Charm's operation (ADR 031). Picking the preset's own answer drops the override,
 * so the hob follows the preset again if it changes later.
 */
export const pickAnswer = (
  permissions: HobPermissions,
  operation: AnyOperation,
  answer: PolicyDecision,
): UpdateHobPermissionsPayload => {
  const follows = answer === presetAnswer(permissions, operation);
  if (isCharmOperation(operation)) {
    const { [operation]: _, ...rest } = permissions.policy.charms?.overrides ?? {};
    return { charms: { overrides: follows ? rest : { ...rest, [operation]: answer } } };
  }
  const { [operation]: _, ...rest } = permissions.policy.overrides;
  return { overrides: follows ? rest : { ...rest, [operation]: answer } };
};

/** The answer a change on its way to the hub gives an operation, or undefined when it leaves it as it is. */
export const sendingAnswer = (
  permissions: HobPermissions,
  sending: UpdateHobPermissionsPayload | undefined,
  operation: AnyOperation,
): PolicyDecision | undefined => {
  const overrides: Readonly<Record<string, PolicyDecision | undefined>> | undefined = isCharmOperation(operation)
    ? sending?.charms?.overrides
    : sending?.overrides;
  return overrides === undefined ? undefined : (overrides[operation] ?? presetAnswer(permissions, operation));
};

/**
 * Whether the rule is held by the sandbox or only checked by Hobbots, under these answers. A Charm's
 * operation runs on the hub, which holds its answer itself.
 */
export const enforcement = (
  operation: AnyOperation,
  decisions: Readonly<Record<AnyOperation, PolicyDecision>>,
  sandbox: SandboxState = "on",
) =>
  isCharmOperation(operation) ? "enforced" : ruleEnforcement(operation, (other) => decisions[other] ?? "deny", sandbox);

/** A folder's last part for its row; the root folder keeps its slash. */
export const folderName = (folder: string): string => {
  const trimmed = trimTrailingSlashes(folder);
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
