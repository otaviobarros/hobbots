import type { HobSkills } from "@hobbots/api";
import {
  AgentId,
  MemoryProjectIdentity,
  SkillId,
  SkillName,
  SkillRevisionHash,
  type SkillScope,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { matchingSkills, pickedDraft, pickerSkills, slashQuery } from "./skill-picker-model.ts";

const pip = AgentId.make("pip");
const skill = (name: string, scope: SkillScope, onlyWhenAsked = false) => ({
  skillId: SkillId.make(name),
  name: SkillName.make(name),
  pin: SkillRevisionHash.make("a".repeat(64)),
  scope,
  onlyWhenAsked,
  missingCharms: [],
});
const view: HobSkills = {
  agentId: pip,
  skills: [
    skill("release-steps", { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/me/site") }, true),
    skill("commit-style", { _tag: "Everyone" }),
    skill("launch-email", { _tag: "Hob", agentId: pip }),
  ],
  replaced: [],
  clashes: [],
  optedOut: [],
  lastUsed: [],
};

describe("picking a skill with / (ADR 029, Explicit use)", () => {
  // covers ADR 029 (Explicit use)
  it("[TC-UI-1096-02] lists the hob's skills by name, with where each comes from and Only when asked", () => {
    expect(pickerSkills(view, "Pip")).toEqual([
      { name: "commit-style", title: "Commit style", sub: "Everyone" },
      { name: "launch-email", title: "Launch email", sub: "Pip's own" },
      { name: "release-steps", title: "Release steps", sub: "site project · only when asked" },
    ]);
    expect(pickerSkills(undefined, "Pip")).toEqual([]);
  });

  // covers ADR 029 (Explicit use)
  it("[TC-UI-1096-03] opens only on a draft that is / and the start of a name, filters by it, and picks /name", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/re")).toBe("re");
    expect(slashQuery("/release-steps Ship it")).toBeNull();
    expect(slashQuery("Use /re")).toBeNull();
    expect(matchingSkills(pickerSkills(view, "Pip"), "re").map((one) => one.name)).toEqual(["release-steps"]);
    expect(matchingSkills(pickerSkills(view, "Pip"), "x")).toEqual([]);
    expect(pickedDraft("release-steps")).toBe("/release-steps ");
  });
});
