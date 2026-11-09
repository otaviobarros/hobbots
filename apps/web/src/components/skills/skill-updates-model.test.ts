import type { SkillsList } from "@hobbots/api";
import {
  type Agent,
  AgentId,
  Revision,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillId,
  SkillName,
  SkillRevisionHash,
  SkillSource,
  SkillSourceId,
  SkillUpdate,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { messages } from "./messages.ts";
import {
  fromGit,
  gitSkillCount,
  otherFilesOf,
  rolloutOf,
  scopeLineOf,
  tagOf,
  updateOf,
  updatesFrom,
  whoGetsIt,
} from "./skill-updates-model.ts";
import { skillsSearchOf, skillsViewOf } from "./skills-model.ts";

// #1097: updates from a skill's Git source (ADR 029, Updates from a source).

const copy = messages.updates;
const AT = "2026-11-06T10:00:00.000Z";
const hash = (n: number) => SkillRevisionHash.make(n.toString(16).padStart(64, "0"));
const revision = Revision.make(1);
const pip = { id: AgentId.make("pip"), name: "Pip" } as Agent;
const hobs = new Map([[pip.id, pip]]);

const skill = (id: string, sourceId: string | null) =>
  new Skill({
    id: SkillId.make(id),
    name: SkillName.make(id),
    description: "A skill.",
    latest: hash(1),
    revisions: 1,
    sourceId: sourceId === null ? null : SkillSourceId.make(sourceId),
    createdAt: AT,
    updatedAt: AT,
    revision,
  });

const assignment = (id: string, skillId: string, scope: SkillAssignment["scope"], held = false) =>
  new SkillAssignment({
    id: SkillAssignmentId.make(id),
    skillId: SkillId.make(skillId),
    scope,
    pin: hash(1),
    held,
    onlyWhenAsked: false,
    by: { _tag: "You" },
    assignedAt: AT,
    revision,
  });

const sources = [
  new SkillSource({
    id: SkillSourceId.make("git"),
    origin: { _tag: "Git", url: "https://github.com/acme/skills.git", ref: "main" },
    addedAt: AT,
  }),
  new SkillSource({ id: SkillSourceId.make("zip"), origin: { _tag: "Archive", fileName: "a.zip" }, addedAt: AT }),
];

const library: SkillsList = {
  skills: [skill("release", "git"), skill("notes", "zip"), skill("mine", null)],
  sources,
  assignments: [
    assignment("a1", "release", { _tag: "Everyone" }),
    assignment("a2", "release", { _tag: "Hob", agentId: pip.id }),
    assignment("a3", "release", { _tag: "Hob", agentId: AgentId.make("gone") }, true),
  ],
  projects: [],
  agentsFolder: { path: null, home: null, problems: [] },
  usesThisWeek: [],
  sets: [],
};

const update = (flags: SkillUpdate["flags"] = []) =>
  new SkillUpdate({
    skillId: SkillId.make("release"),
    name: SkillName.make("release"),
    sourceId: SkillSourceId.make("git"),
    base: hash(1),
    baseNumber: 1,
    hash: hash(2),
    commit: "abc1234def",
    label: null,
    path: "skills/release",
    files: [
      { path: "SKILL.md", change: "changed", mode: "regular", size: 10 },
      { path: "scripts/check.sh", change: "added", mode: "executable", size: 20 },
      { path: "notes.md", change: "removed", mode: "regular", size: 5 },
    ],
    instructions: [{ path: "SKILL.md", before: "a", after: "b", cut: false }],
    flags,
    state: "waiting",
    foundAt: AT,
  });

describe("updates from a source", () => {
  // covers ADR 029 (Updates from a source), #1097
  it("[TC-UX-1097-01] opens Updates, and an update in it, from the address it writes", () => {
    for (const view of [
      { _tag: "Updates", item: null },
      { _tag: "Updates", item: SkillId.make("release") },
    ] as const)
      expect(skillsViewOf(skillsSearchOf(view))).toEqual(view);
  });

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-UX-1097-02] follows only skills from Git, and names where each updates from", () => {
    expect(library.skills.map((one) => fromGit(one, library))).toEqual([true, false, false]);
    expect(gitSkillCount(library)).toBe(1);
    expect(updatesFrom(SkillSourceId.make("git"), library)).toBe("github.com/acme/skills · main");
  });

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-UX-1097-03] tags a clean update Clean and a flagged one by its first flag, and notes a new script", () => {
    expect(tagOf(update())).toEqual({ tone: "set", text: copy.clean });
    const flagged = update([{ _tag: "Script", path: "scripts/check.sh" }]);
    expect(tagOf(flagged)).toEqual({ tone: "needs", text: copy.addsScript });
    expect(otherFilesOf(flagged)).toEqual([
      { path: "scripts/check.sh", note: copy.scriptNote.added },
      { path: "notes.md", note: copy.fileNote.removed },
    ]);
  });

  // covers ADR 029 (Updates from a source), #1097
  it("[TC-UX-1097-04] rolls out to every place that is not held, and says who gets it", () => {
    const id = SkillId.make("release");
    expect(rolloutOf(id, library).map((one) => one.id)).toEqual(["a1", "a2"]);
    expect(whoGetsIt(id, library, hobs)).toBe("Everyone, Pip");
    expect(scopeLineOf(id, library, hobs)).toBe("Everyone");
    expect(whoGetsIt(SkillId.make("mine"), library, hobs)).toBe(copy.nobody);
    expect(updateOf([update()], id)?.hash).toBe(hash(2));
    expect(updateOf(undefined, id)).toBeNull();
  });
});
