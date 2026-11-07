import { SkillId, SkillRevisionHash } from "@hobbots/domain";
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
    };
    expect(usedLine(library)).toEqual({ title: "Release steps", detail: "(r4)" });
    expect(
      usedLine({ ...library, source: "organization", skillId: null, pin: null, number: null, name: "security" }),
    ).toEqual({ title: "Security", detail: "(from your organization)" });
  });
});
