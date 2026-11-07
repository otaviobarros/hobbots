import {
  AgentId,
  MemoryProjectIdentity,
  SkillAssignment,
  SkillAssignmentId,
  SkillId,
  SkillName,
  SkillRevisionHash,
  type SkillScope,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { type PinnedSkill, resolveSkills, rolloutTargets, type SkillTurn } from "../src/index.ts";
import { mentionedSkill, runtimePrompt, withoutMention } from "../src/skill-turn.ts";

const PIP = AgentId.make("pip");
const QUILL = AgentId.make("quill");
const WEB = MemoryProjectIdentity.make("github.com/acme/web");
const API = MemoryProjectIdentity.make("github.com/acme/api");
const R1 = SkillRevisionHash.make("1".repeat(64));
const R2 = SkillRevisionHash.make("2".repeat(64));

let next = 0;
const pinned = (name: string, scope: SkillScope, more: Partial<SkillAssignment> = {}, charms: string[] = []) => {
  next += 1;
  const assignment = new SkillAssignment({
    id: SkillAssignmentId.make(`a${next}`),
    skillId: SkillId.make(`${name}-${scope._tag}-${next}`),
    scope,
    pin: R1,
    held: false,
    by: { _tag: "You" },
    assignedAt: "2026-11-06T00:00:00.000Z",
    ...more,
  });
  return { assignment, name: SkillName.make(name), charms } satisfies PinnedSkill;
};

const turn = (more: Partial<SkillTurn> = {}): SkillTurn => ({
  agentId: PIP,
  projects: [WEB],
  charms: [],
  optedOut: [],
  ...more,
});

const names = (resolved: ReturnType<typeof resolveSkills>) => resolved.skills.map((one) => one.name);

describe("resolveSkills", () => {
  it("gives a hob Everyone's skills, its projects' and its own, and nobody else's", () => {
    const resolved = resolveSkills(
      [
        pinned("commit-style", { _tag: "Everyone" }),
        pinned("web-release", { _tag: "Project", identity: WEB }),
        pinned("api-release", { _tag: "Project", identity: API }),
        pinned("pip-notes", { _tag: "Hob", agentId: PIP }),
        pinned("quill-notes", { _tag: "Hob", agentId: QUILL }),
      ],
      turn(),
    );
    expect(names(resolved)).toEqual(["commit-style", "pip-notes", "web-release"]);
    expect(resolved.replaced).toEqual([]);
    expect(resolved.clashes).toEqual([]);
  });

  it("lets the narrower scope win a name, and reports what it replaced", () => {
    const everyone = pinned("release", { _tag: "Everyone" });
    const project = pinned("release", { _tag: "Project", identity: WEB });
    const own = pinned("release", { _tag: "Hob", agentId: PIP }, { onlyWhenAsked: true });
    const resolved = resolveSkills([everyone, project, own], turn());
    expect(resolved.skills).toHaveLength(1);
    expect(resolved.skills[0]?.skillId).toBe(own.assignment.skillId);
    expect(resolved.skills[0]?.onlyWhenAsked).toBe(true);
    expect(resolved.replaced.map((one) => one.assignment)).toEqual([everyone.assignment, project.assignment]);
    // Without its own, the project's replaces Everyone's.
    expect(resolveSkills([everyone, project], turn()).skills[0]?.skillId).toBe(project.assignment.skillId);
  });

  it("loads neither of two projects' skills of one name, and says so", () => {
    const web = pinned("release", { _tag: "Project", identity: WEB });
    const api = pinned("release", { _tag: "Project", identity: API });
    const everyone = pinned("release", { _tag: "Everyone" });
    const resolved = resolveSkills([web, api, everyone], turn({ projects: [WEB, API] }));
    expect(resolved.skills).toEqual([]);
    expect(resolved.clashes).toEqual([{ name: "release", assignments: [web.assignment, api.assignment] }]);
  });

  it("leaves out an Everyone or Project skill the hob opted out of, but never its own", () => {
    const everyone = pinned("commit-style", { _tag: "Everyone" });
    const project = pinned("web-release", { _tag: "Project", identity: WEB });
    const own = pinned("pip-notes", { _tag: "Hob", agentId: PIP });
    const optedOut = [everyone.assignment.skillId, project.assignment.skillId, own.assignment.skillId];
    expect(names(resolveSkills([everyone, project, own], turn({ optedOut })))).toEqual(["pip-notes"]);
  });

  it("an opted-out skill no longer replaces a wider one of its name", () => {
    const everyone = pinned("release", { _tag: "Everyone" });
    const project = pinned("release", { _tag: "Project", identity: WEB });
    const resolved = resolveSkills([everyone, project], turn({ optedOut: [project.assignment.skillId] }));
    expect(resolved.skills[0]?.skillId).toBe(everyone.assignment.skillId);
  });

  it("names the Charms a skill needs that the hob has not got", () => {
    const resolved = resolveSkills(
      [pinned("pull-requests", { _tag: "Everyone" }, {}, ["github", "linear"])],
      turn({ charms: ["github"] }),
    );
    expect(resolved.skills[0]?.missingCharms).toEqual(["linear"]);
  });
});

/** A set assigned to `scope`, bringing `skills`. */
const setOf = (
  name: string,
  skills: ReadonlyArray<string>,
  scope: SkillScope,
  more: Partial<SkillAssignment> = {},
) => ({
  ...pinned(name, scope, more),
  set: { skills: skills.map((skill) => ({ name: SkillName.make(skill), charms: [] })) },
});

describe("resolveSkills with sets (ADR 029, Skill sets)", () => {
  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-08] gives each skill of a set on the set's pin, named with its set", () => {
    const set = setOf("agent-engineering", ["deliver-change", "plan-change"], { _tag: "Everyone" }, { pin: R2 });
    const resolved = resolveSkills([set], turn());
    expect(resolved.skills.map((one) => [one.name, one.set, one.pin, one.skillId])).toEqual([
      ["deliver-change", "agent-engineering", R2, set.assignment.skillId],
      ["plan-change", "agent-engineering", R2, set.assignment.skillId],
    ]);
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-09] loads two skills of one name in one scope, from two sets or a set and a skill", () => {
    const one = setOf("agent-engineering", ["plan-change"], { _tag: "Everyone" });
    const other = setOf("other-set", ["plan-change"], { _tag: "Everyone" });
    const loose = pinned("plan-change", { _tag: "Everyone" });
    const resolved = resolveSkills([one, other, loose], turn());
    expect(resolved.skills.map((skill) => [skill.name, skill.set])).toEqual([
      ["plan-change", null],
      ["plan-change", "agent-engineering"],
      ["plan-change", "other-set"],
    ]);
    expect(resolved.clashes).toEqual([]);
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-10] a narrower skill replaces the set's of its name only; two projects' still load neither", () => {
    const set = setOf("agent-engineering", ["deliver-change", "plan-change"], { _tag: "Everyone" });
    const own = pinned("plan-change", { _tag: "Hob", agentId: PIP });
    const replacedBy = resolveSkills([set, own], turn());
    expect(replacedBy.skills.map((skill) => [skill.name, skill.set])).toEqual([
      ["deliver-change", "agent-engineering"],
      ["plan-change", null],
    ]);
    expect(replacedBy.replaced).toEqual([{ assignment: set.assignment, by: own.assignment, name: "plan-change" }]);
    const web = setOf("agent-engineering", ["plan-change"], { _tag: "Project", identity: WEB });
    const api = pinned("plan-change", { _tag: "Project", identity: API });
    const clash = resolveSkills([web, api], turn({ projects: [WEB, API] }));
    expect(clash.skills).toEqual([]);
    expect(clash.clashes).toEqual([{ name: "plan-change", assignments: [web.assignment, api.assignment] }]);
  });

  // covers ADR 029 (Skill sets, Pins and rollout), #1143
  it("[TC-AG-1143-13] takes a set whole from its narrowest assignment, so a held revision never mixes with a newer one", () => {
    const own = setOf("agent-engineering", ["plan-change"], { _tag: "Hob", agentId: PIP }, { held: true });
    const skillId = own.assignment.skillId;
    const everyone = setOf(
      "agent-engineering",
      ["plan-change", "ship-change"],
      { _tag: "Everyone" },
      { skillId, pin: R2 },
    );
    const resolved = resolveSkills([everyone, own], turn());
    expect(resolved.skills.map((one) => [one.name, one.pin])).toEqual([["plan-change", R1]]);
    expect(resolved.replaced).toEqual([
      { assignment: everyone.assignment, by: own.assignment, name: "agent-engineering" },
    ]);
    // Two projects that assign the set load none of it, whichever skills each revision holds.
    const web = setOf("agent-engineering", ["plan-change"], { _tag: "Project", identity: WEB }, { skillId });
    const api = setOf(
      "agent-engineering",
      ["plan-change", "ship-change"],
      { _tag: "Project", identity: API },
      { skillId, pin: R2 },
    );
    const clash = resolveSkills([web, api], turn({ projects: [WEB, API] }));
    expect(clash.skills).toEqual([]);
    expect(clash.clashes.map((one) => one.name)).toEqual(["plan-change", "ship-change"]);
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-11] leaves out a skill of a set the hob opted out of, but never one of its own set", () => {
    const everyone = setOf("agent-engineering", ["deliver-change", "plan-change"], { _tag: "Everyone" });
    const own = setOf("pip-set", ["pip-notes", "pip-plan"], { _tag: "Hob", agentId: PIP });
    const optedOutOfSets = [
      { skillId: everyone.assignment.skillId, name: SkillName.make("plan-change") },
      { skillId: own.assignment.skillId, name: SkillName.make("pip-plan") },
    ];
    expect(names(resolveSkills([everyone, own], turn({ optedOutOfSets })))).toEqual([
      "deliver-change",
      "pip-notes",
      "pip-plan",
    ]);
  });
});

describe("skill mentions", () => {
  const given = [
    {
      skillId: SkillId.make("s1"),
      name: SkillName.make("deliver-change"),
      pin: R1,
      onlyWhenAsked: false,
      set: SkillName.make("agent-engineering"),
    },
    {
      skillId: SkillId.make("s1"),
      name: SkillName.make("plan-change"),
      pin: R1,
      onlyWhenAsked: false,
      set: SkillName.make("agent-engineering"),
    },
    {
      skillId: SkillId.make("s2"),
      name: SkillName.make("plan-change"),
      pin: R1,
      onlyWhenAsked: false,
      set: SkillName.make("other-set"),
    },
    { skillId: SkillId.make("s3"), name: SkillName.make("release"), pin: R1, onlyWhenAsked: false, set: null },
  ];

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-12] takes a set's skill by its set and name, or by its name while no other skill has it", () => {
    expect(mentionedSkill("/agent-engineering:deliver-change go", given)).toBe("agent-engineering:deliver-change");
    expect(mentionedSkill("/deliver-change go", given)).toBe("agent-engineering:deliver-change");
    expect(mentionedSkill("/other-set:plan-change", given)).toBe("other-set:plan-change");
    expect(mentionedSkill("/plan-change go", given)).toBeNull();
    expect(mentionedSkill("/release now", given)).toBe("release");
    expect(mentionedSkill("/agent-engineering:release", given)).toBeNull();
    expect(withoutMention("/deliver-change go", "agent-engineering:deliver-change")).toBe("go");
    expect(withoutMention("/agent-engineering:deliver-change go", "agent-engineering:deliver-change")).toBe("go");
    expect(withoutMention("/plan-change go", "other-set:deliver-change")).toBe("/plan-change go");
    // A bare name two sets share reaches the runtime as plain text, so no runtime picks one on its own.
    expect(runtimePrompt("/plan-change go", null, given)).toBe("plan-change go");
    expect(runtimePrompt("/release now", null, given)).toBe("/release now");
    expect(runtimePrompt("/other-set:plan-change go", "other-set:plan-change", given)).toBe("go");
  });
});

describe("rolloutTargets", () => {
  it("rolls a new revision out to the skill's assignments that are not held or on it already", () => {
    const moving = pinned("release", { _tag: "Everyone" });
    const skillId = moving.assignment.skillId;
    const held = pinned("release", { _tag: "Hob", agentId: PIP }, { skillId, held: true });
    const current = pinned("release", { _tag: "Hob", agentId: QUILL }, { skillId, pin: R2 });
    const other = pinned("other", { _tag: "Everyone" });
    const all = [moving, held, current, other].map((one) => one.assignment);
    expect(rolloutTargets(all, skillId, R2)).toEqual([moving.assignment]);
  });
});
