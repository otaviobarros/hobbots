import type { SafetyPreset } from "@hobbots/domain";

/**
 * The onboarding safety presets as the Hobbots design words them. Hobbots stores the choice now;
 * the rules shown are the design's summary of what each preset will allow. Hobs only chat today,
 * so the UI says so wherever it shows them (see "Enforcement honesty" in permissions.md).
 */

export type RuleAnswer = "Allow" | "Ask" | "Never";

export interface PresetInfo {
  readonly id: SafetyPreset;
  readonly label: string;
  readonly note: string;
  /** What the Elder Hob says when the user picks it. */
  readonly guide: string;
  readonly recommended: boolean;
  readonly rules: ReadonlyArray<readonly [string, RuleAnswer]>;
}

export const PRESETS: ReadonlyArray<PresetInfo> = [
  {
    id: "careful",
    label: "Careful",
    note: "Asks before almost everything. Good for your first week.",
    guide: "Careful it is. Once hobs can act, yours will ask about almost everything. Slow, but very safe.",
    recommended: false,
    rules: [
      ["Read your folders", "Ask"],
      ["Browse the web", "Ask"],
      ["Send messages", "Ask"],
      ["Delete files", "Never"],
      ["Pay for things", "Never"],
    ],
  },
  {
    id: "balanced",
    label: "Balanced",
    note: "Reads and browses freely. Anything risky waits for you.",
    guide:
      "Balanced is what most people pick. Once hobs can act, reading and browsing are fine and anything risky waits for you.",
    recommended: true,
    rules: [
      ["Read your folders", "Allow"],
      ["Browse the web", "Allow"],
      ["Send messages", "Ask"],
      ["Delete files", "Ask"],
      ["Pay for things", "Never"],
    ],
  },
  {
    id: "trusting",
    label: "Trusting",
    note: "Gets on with chores and tells you after. Best for hobs you know well.",
    guide: "Trusting! Once hobs can act, yours will just get on with it. Paying for things still stays off.",
    recommended: false,
    rules: [
      ["Read your folders", "Allow"],
      ["Browse the web", "Allow"],
      ["Send messages", "Allow"],
      ["Delete files", "Ask"],
      ["Pay for things", "Never"],
    ],
  },
];

export const presetInfo = (id: SafetyPreset): PresetInfo =>
  PRESETS.find((p) => p.id === id) ?? (PRESETS[1] as PresetInfo);

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
