import { SkillId, SkillName, SkillRevisionHash } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { usedLine, usedPage } from "./skill-line-model.ts";

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

  // covers ADR 029 (The use line)
  it("[TC-UI-1194-01] opens a library skill's page, a set's skill in its set, and nothing for your organization's", () => {
    const library = {
      source: "library" as const,
      skillId: SkillId.make("s1"),
      name: "release-steps",
      pin: SkillRevisionHash.make("a".repeat(64)),
      number: 4,
      explicit: false,
      set: null,
    };
    expect(usedPage(library)).toMatchObject({ _tag: "Skill", skillId: "s1", member: null });
    expect(
      usedPage({
        ...library,
        skillId: SkillId.make("set1"),
        name: "deliver-change",
        set: SkillName.make("agent-engineering"),
      }),
    ).toMatchObject({
      _tag: "Skill",
      skillId: "set1",
      member: "deliver-change",
    });
    expect(
      usedPage({ ...library, source: "organization", skillId: null, pin: null, number: null, name: "security" }),
    ).toBeNull();
  });
});
