import { SkillId, SkillName, SkillRevisionHash } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { usedLine } from "./skill-line-model.ts";

describe("the line for a skill a reply used (ADR 029)", () => {
  // covers ADR 029 (The use line)
  it("[TC-UI-1096-01] names the skill as the screens do, with its revision, or that it is your organization's", () => {
    const library = {
      source: "library" as const,
      skillId: SkillId.make("s1"),
      name: "release-steps",
      pin: SkillRevisionHash.make("a".repeat(64)),
      number: 4,
      explicit: false,
      set: null,
    };
    expect(usedLine(library)).toEqual({ title: "Release steps", detail: "(r4)" });
    expect(
      usedLine({ ...library, source: "organization", skillId: null, pin: null, number: null, name: "security" }),
    ).toEqual({ title: "Security", detail: "(from your organization)" });
  });

  // covers ADR 029 (Skill sets, The use line)
  it("[TC-UI-1192-01] names the set a set's skill comes from, before the set's revision", () => {
    const fromSet = {
      source: "library" as const,
      skillId: SkillId.make("s2"),
      name: "deliver-change",
      pin: SkillRevisionHash.make("b".repeat(64)),
      number: 1,
      explicit: true,
      set: SkillName.make("agent-engineering"),
    };
    expect(usedLine(fromSet)).toEqual({ title: "Deliver change", detail: "from agent-engineering (r1)" });
    expect(usedLine({ ...fromSet, number: null })).toEqual({
      title: "Deliver change",
      detail: "from agent-engineering",
    });
  });
});
