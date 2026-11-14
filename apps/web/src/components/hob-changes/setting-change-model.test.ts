import { HUB_ACTOR, OWNER_ACTOR, type SettingChange, type SettingDiff } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { settingLines, settingMakerLine, settingReachLine, settingTitle } from "./setting-change-model.ts";

const scope = { summoned: true, self: false, hobs: ["wren"] };
const on: SettingDiff = {
  setting: "summoningForEveryHob",
  before: null,
  after: { scope, overrides: { "summoning.summon": "ask" } },
};
const answered: SettingDiff = {
  setting: "summoningForEveryHob",
  before: { scope, overrides: { "summoning.summon": "ask" } },
  after: { scope, overrides: { "summoning.summon": "allow" } },
};
const off: SettingDiff = { setting: "summoningForEveryHob", before: answered.after, after: null };
const preset: SettingDiff = { setting: "safetyPreset", before: "balanced", after: "careful" };
const folders: SettingDiff = { setting: "approvedFolders", before: ["/a"], after: ["/a", "/b"] };

describe("setting changes", () => {
  // covers AG-002, #1357
  it("[TC-UX-1357-01] titles a setting change for Settings and words what it did to each hob it reached", () => {
    expect([on, answered, off, preset, folders].map(settingTitle)).toEqual([
      "Summoning for every hob turned on",
      "Summoning for every hob changed",
      "Summoning for every hob turned off",
      "How careful hobs are changed",
      "Folders hobs can open changed",
    ]);
    expect([on, answered, off, preset, folders].map((diff) => settingReachLine(diff, "Pip"))).toEqual([
      "Gave Pip the Summoning Charm.",
      "Changed what Pip may do with the Summoning Charm.",
      "Took the Summoning Charm from Pip.",
      "Changed how often Pip asks you first.",
      "Changed the folders Pip can open.",
    ]);
  });

  // covers AG-002, #1357
  it("[TC-UX-1357-02] shows only the parts a change moved, before and after, naming picked hobs", () => {
    expect(settingLines(preset)).toEqual([
      { label: "How careful", before: "Balanced", after: "Careful", lines: false },
    ]);
    expect(settingLines(folders)).toEqual([{ label: "Folders", before: "/a", after: "/a\n/b", lines: true }]);
    expect(settingLines(answered).map((line) => line.label)).toEqual(["Answers"]);
    const turnedOn = settingLines(on, (id) => (id === "wren" ? "Wren" : "?"));
    expect(turnedOn.map((line) => [line.label, line.before, line.after])).toEqual([
      ["Turned", "Off", "On"],
      ["Summoning manages", "", "Hobs it summoned: Yes\nItself: No\nPicked by you: Wren"],
      ["Answers", "", expect.stringContaining(": Ask")],
    ]);
    const change = (actor: SettingChange["actor"]): SettingChange => ({
      id: "s1",
      at: "2026-11-14T00:00:00.000Z",
      actor,
      diff: on,
    });
    expect([settingMakerLine(change(OWNER_ACTOR)), settingMakerLine(change(HUB_ACTOR))]).toEqual([
      "By you",
      "By Hobbots",
    ]);
  });
});
