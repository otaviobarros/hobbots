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
