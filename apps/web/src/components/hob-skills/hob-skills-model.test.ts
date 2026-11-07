import type { HobSkills, SkillsList } from "@hobbots/api";
import {
  AgentId,
  MemoryProjectIdentity,
  Revision,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillId,
  SkillName,
  SkillRevisionHash,
  type SkillScope,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { carriedGroups, everyoneCount, giveOffers, summonOffers } from "./hob-skills-model.ts";

const hash = (n: number) => SkillRevisionHash.make(n.toString(16).padStart(64, "0"));
const AT = "2026-11-06T10:00:00.000Z";
const pip = AgentId.make("pip");
const bram = AgentId.make("bram");
const site = MemoryProjectIdentity.make("github.com/me/site");
const docs = MemoryProjectIdentity.make("github.com/me/docs");
const everyone: SkillScope = { _tag: "Everyone" };
const project = (identity: MemoryProjectIdentity): SkillScope => ({ _tag: "Project", identity });
const own = (agentId: AgentId): SkillScope => ({ _tag: "Hob", agentId });

const skill = (name: string, revisions = 1) =>
  new Skill({
    id: SkillId.make(name),
    name: SkillName.make(name),
    description: `Use when ${name}.`,
    latest: hash(revisions),
    revisions,
    sourceId: null,
    createdAt: AT,
    updatedAt: AT,
    revision: Revision.make(1),
  });

const assignment = (name: string, scope: SkillScope, pin = hash(1), held = false) =>
  new SkillAssignment({
    id: SkillAssignmentId.make(`${name}-${scope._tag}`),
    skillId: SkillId.make(name),
    scope,
    pin,
    held,
    onlyWhenAsked: false,
    by: { _tag: "You" },
    assignedAt: AT,
    revision: Revision.make(1),
  });

const loaded = (name: string, scope: SkillScope, pin = hash(1), missingCharms: ReadonlyArray<string> = []) => ({
  skillId: SkillId.make(name),
  name: SkillName.make(name),
  pin,
  scope,
  onlyWhenAsked: false,
  missingCharms,
  set: null,
});

const skills = [
  skill("commit-style", 2),
  skill("astro"),
  skill("deploy"),
  skill("style"),
  skill("support"),
  skill("loose"),
];
const assignments = [
  assignment("commit-style", everyone, hash(1), true),
  assignment("astro", project(site)),
  assignment("deploy", project(site)),
  assignment("deploy", project(docs)),
  assignment("style", everyone),
  assignment("style", own(pip)),
  assignment("support", own(bram)),
];
const list: SkillsList = {
  skills,
  sources: [],
  assignments,
  projects: [site, docs],
  agentsFolder: { path: null, problems: [] },
  usesThisWeek: [],
  sets: [],
};
const [, , deploySite, deployDocs, styleEveryone, stylePip] = assignments;
if (!deploySite || !deployDocs || !styleEveryone || !stylePip) throw new Error("fixture");
const view: HobSkills = {
  agentId: pip,
  skills: [loaded("commit-style", everyone, hash(1), ["github"]), loaded("style", own(pip))],
  replaced: [{ assignment: styleEveryone, by: stylePip, name: SkillName.make("style") }],
  clashes: [{ name: SkillName.make("deploy"), assignments: [deploySite, deployDocs] }],
  optedOut: [SkillId.make("astro")],
  optedOutOfSets: [],
  projects: [site, docs],
  lastUsed: [],
};

describe("a hob's skills (ADR 029, Scopes)", () => {
  // covers ADR 029 (Scopes, Pins and rollout), #1062
  it("[TC-UI-1062-01] lists what a hob carries by scope, with skills turned off, replaced, clashing and held back", () => {
    const groups = carriedGroups(view, list);
    expect(groups.map((group) => group.key)).toEqual(["everyone", `project:${docs}`, `project:${site}`, `hob:${pip}`]);
    const rows = groups.map((group) =>
      group.rows.map((row) => [row.skill.name, row.state._tag, row.number, row.newer, row.held]),
    );
    expect(rows).toEqual([
      [
        ["commit-style", "Loads", null, 2, true],
        ["style", "Replaced", 1, null, false],
      ],
      [["deploy", "Clash", 1, null, false]],
      [
        ["astro", "Off", 1, null, false],
        ["deploy", "Clash", 1, null, false],
      ],
      [["style", "Loads", 1, null, false]],
    ]);
    expect(groups[0]?.rows[0]?.missingCharms).toEqual(["github"]);
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-UI-1143-02] lists each skill of a set a hob gets, and one it turned off, under the set's scope", () => {
    const set = skill("agent-engineering");
    const setEveryone = assignment("agent-engineering", everyone);
    const member = (name: string) => ({
      name: SkillName.make(name),
      description: `Use to ${name}.`,
      path: `skills/${name}`,
      charms: [],
    });
    const withSet: SkillsList = {
      ...list,
      skills: [...skills, set],
      assignments: [...assignments, setEveryone],
      sets: [{ skillId: set.id, skills: [member("plan-change"), member("deliver-change")] }],
    };
    const fromSet = { ...loaded("agent-engineering", everyone), name: SkillName.make("deliver-change") };
    const hob: HobSkills = {
      ...view,
      skills: [...view.skills, { ...fromSet, set: SkillName.make("agent-engineering") }],
      optedOutOfSets: [{ skillId: set.id, name: SkillName.make("plan-change") }],
    };
    const [everyoneGroup] = carriedGroups(hob, withSet);
    const fromTheSet = everyoneGroup?.rows.filter((row) => row.skill.id === set.id);
    expect(fromTheSet?.map((row) => [row.member?.name, row.member?.description, row.state._tag])).toEqual([
      ["deliver-change", "Use to deliver-change.", "Loads"],
      ["plan-change", "Use to plan-change.", "Off"],
    ]);
  });

  // covers ADR 029 (A hob's Skills tab), #1062
  it("[TC-UI-1062-02] offers the skills a hob does not carry, and the shared ones it turned off, to turn on again", () => {
    expect(giveOffers(view, list).map((offer) => [offer._tag, offer.skill.name])).toEqual([
      ["TurnOn", "astro"],
      ["Give", "loose"],
      ["Give", "support"],
    ]);
    const support = giveOffers(view, list).find((offer) => offer.skill.name === "support");
    expect(support).toMatchObject({ given: [own(bram)] });
    // Summon offers every skill Everyone does not give already.
    expect(summonOffers(list).map((offer) => offer.skill.name)).toEqual(["astro", "deploy", "loose", "support"]);
    expect(everyoneCount(list)).toBe(2);
  });
});
