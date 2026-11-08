import { SKILL_LISTING_BUDGET } from "@hobbots/api";
import {
  AgentId,
  MemoryProjectIdentity,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillId,
  SkillName,
  SkillRevisionHash,
  type SkillScope,
  SkillTrial,
} from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { descriptionProblem, type HealthInput, resolveSkills, skillHealth } from "../src/index.ts";
import { namedSkills, skillUseRecorder } from "../src/skill-turn.ts";

const PIP = AgentId.make("pip");
const WEB = MemoryProjectIdentity.make("github.com/acme/web");
const API = MemoryProjectIdentity.make("github.com/acme/api");
const R1 = SkillRevisionHash.make("1".repeat(64));
const R2 = SkillRevisionHash.make("2".repeat(64));
const NOW = "2026-11-08T00:00:00.000Z";
const LONG_AGO = "2026-08-01T00:00:00.000Z";
const LATELY = "2026-11-01T00:00:00.000Z";
const GOOD = "Cuts a release when you ask to ship a version, tagging it and writing its notes.";

const skill = (name: string, more: Partial<Skill> = {}) =>
  new Skill({
    id: SkillId.make(name),
    name: SkillName.make(name),
    description: GOOD,
    latest: R2,
    revisions: 2,
    sourceId: null,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...more,
  });

let next = 0;
const assignment = (skillId: string, scope: SkillScope, more: Partial<SkillAssignment> = {}) => {
  next += 1;
  return new SkillAssignment({
    id: SkillAssignmentId.make(`a${next}`),
    skillId: SkillId.make(skillId),
    scope,
    pin: R2,
    held: false,
    by: { _tag: "You" },
    assignedAt: LONG_AGO,
    ...more,
  });
};

const input = (more: Partial<HealthInput>): HealthInput => ({
  now: NOW,
  skills: [],
  newest: new Map(),
  assignments: [],
  numbers: new Map([
    [R1, 1],
    [R2, 2],
  ]),
  lastUsedAt: [],
  hobs: [],
  ...more,
});

describe("the Skills Overview's health checks (ADR 029, Health checks)", () => {
  // covers ADR 029 (Health checks), #1099
  it("[TC-AG-1099-01] names a skill some place gets that nobody used in 60 days, and leaves alone one added lately or given to nobody", () => {
    const stale = skill("stale");
    const fresh = skill("fresh", { createdAt: LATELY });
    const idle = skill("idle");
    const used = skill("used");
    const health = skillHealth(
      input({
        skills: [stale, fresh, idle, used],
        assignments: [
          assignment("stale", { _tag: "Everyone" }),
          assignment("stale", { _tag: "Hob", agentId: PIP }),
          assignment("fresh", { _tag: "Everyone" }),
          assignment("used", { _tag: "Everyone" }),
        ],
        lastUsedAt: [{ skillId: used.id, at: LATELY }],
      }),
    );
    expect(health.unused).toEqual([{ skillId: stale.id, name: "stale", lastUsedAt: null, assignments: 2 }]);

    const once = skillHealth(
      input({
        skills: [used],
        assignments: [assignment("used", { _tag: "Everyone" })],
        lastUsedAt: [{ skillId: used.id, at: LONG_AGO }],
      }),
    );
    expect(once.unused).toEqual([{ skillId: used.id, name: "used", lastUsedAt: LONG_AGO, assignments: 1 }]);
  });

  it("[TC-AG-1099-02] names each place a revision behind, held or not, and one on a revision the library lost", () => {
    const release = skill("release");
    const held = assignment("release", { _tag: "Hob", agentId: PIP }, { pin: R1, held: true });
    const lost = SkillRevisionHash.make("9".repeat(64));
    const gone = assignment("release", { _tag: "Project", identity: WEB }, { pin: lost });
    const health = skillHealth(
      input({ skills: [release], assignments: [assignment("release", { _tag: "Everyone" }), held, gone] }),
    );
    expect(health.behind).toEqual([
      {
        assignmentId: held.id,
        skillId: release.id,
        name: "release",
        scope: held.scope,
        pin: R1,
        number: 1,
        latest: 2,
        held: true,
      },
      {
        assignmentId: gone.id,
        skillId: release.id,
        name: "release",
        scope: gone.scope,
        pin: lost,
        number: null,
        latest: 2,
        held: false,
      },
    ]);
  });

  it("[TC-AG-1099-03] names a hob's clashes: two projects defining a name, another skill replacing one, never a pin of the same skill", () => {
    const pinned = (name: string, skillId: string, scope: SkillScope) => ({
      assignment: assignment(skillId, scope),
      name: SkillName.make(name),
      charms: [],
    });
    const resolved = resolveSkills(
      [
        pinned("deploy", "deploy-web", { _tag: "Project", identity: WEB }),
        pinned("deploy", "deploy-api", { _tag: "Project", identity: API }),
        pinned("notes", "notes-everyone", { _tag: "Everyone" }),
        pinned("notes", "notes-pip", { _tag: "Hob", agentId: PIP }),
        pinned("release", "release", { _tag: "Everyone" }),
        pinned("release", "release", { _tag: "Hob", agentId: PIP }),
      ],
      { agentId: PIP, projects: [WEB, API], charms: [], optedOut: [] },
    );
    const health = skillHealth(
      input({ hobs: [{ agentId: PIP, runtime: "claude-code", resolved, descriptions: new Map() }] }),
    );
    expect(health.clashes).toEqual([
      { agentId: PIP, name: "deploy", kind: "projects", skillIds: ["deploy-web", "deploy-api"] },
      { agentId: PIP, name: "notes", kind: "replaced", skillIds: ["notes-pip", "notes-everyone"] },
    ]);
  });

  it("[TC-AG-1099-04] calls a description vague when it is short or says nothing of when to use it, and long past 500 characters", () => {
    expect(descriptionProblem(GOOD)).toBeNull();
    expect(descriptionProblem("Releases.")).toBe("vague");
    expect(descriptionProblem("Everything about releases, versions, changelogs and tags in this repo.")).toBe("vague");
    expect(descriptionProblem(`Use when you ship. ${"x".repeat(500)}`)).toBe("long");
    const vague = skill("vague", { description: "Releases." });
    const health = skillHealth(input({ skills: [skill("release"), vague] }));
    expect(health.descriptions).toEqual([
      { skillId: vague.id, name: "vague", set: null, problem: "vague", length: "Releases.".length },
    ]);
  });

  it("[TC-AG-1099-05] counts each hob's skills and the characters its listing takes, leaving out Only when asked skills", () => {
    const resolved = resolveSkills(
      [
        { assignment: assignment("release", { _tag: "Everyone" }), name: SkillName.make("release"), charms: [] },
        {
          assignment: assignment("notes", { _tag: "Everyone" }, { onlyWhenAsked: true }),
          name: SkillName.make("notes"),
          charms: [],
        },
      ],
      { agentId: PIP, projects: [], charms: [], optedOut: [] },
    );
    const descriptions = new Map([
      ["release", GOOD],
      ["notes", "x".repeat(400)],
    ]);
    const health = skillHealth(input({ hobs: [{ agentId: PIP, runtime: "codex", resolved, descriptions }] }));
    expect(health.loads).toEqual([
      {
        agentId: PIP,
        runtime: "codex",
        skills: 2,
        characters: `release: ${GOOD}`.length,
        budget: SKILL_LISTING_BUDGET,
      },
    ]);
  });
});

describe("a chat that tries a draft (ADR 029, Try in a chat)", () => {
  const trial = new SkillTrial({
    name: SkillName.make("changelog"),
    description: GOOD,
    hash: R1,
    skillId: null,
    base: null,
    proposalId: "p1",
  });
  const release = { skillId: SkillId.make("release"), name: SkillName.make("release"), pin: R2, onlyWhenAsked: false };

  it("[TC-AG-1099-06] lets / name the draft alone, and none of the hob's own skills", () => {
    expect(namedSkills([release], trial)).toEqual([{ name: "changelog", set: null }]);
    expect(namedSkills([release], null)).toEqual([release]);
  });

  it("[TC-AG-1099-07] shows a use of the draft under the reply and records nothing in the library", async () => {
    const used = await Effect.runPromise(
      Effect.gen(function* () {
        const uses = yield* skillUseRecorder({ agentId: PIP, threadId: null, messageId: null });
        uses.given([], trial);
        return [
          yield* uses.resolve({ source: "library", name: "changelog", explicit: true }),
          yield* uses.resolve({ source: "library", name: "release", explicit: false }),
        ];
      }),
    );
    expect(used).toEqual([
      {
        used: {
          source: "draft",
          skillId: null,
          name: "changelog",
          pin: R1,
          number: null,
          explicit: true,
          set: null,
        },
        use: null,
      },
      null,
    ]);
  });
});
