import type { SkillsList } from "@hobbots/api";
import {
  type Agent,
  AgentId,
  MemoryProjectIdentity,
  Revision,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillId,
  SkillName,
  SkillRevision,
  SkillRevisionHash,
  SkillSource,
  SkillSourceId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  agentsFolderOf,
  descriptionState,
  draftingHobs,
  exportRows,
  fileChanges,
  importable,
  instructionsOf,
  libraryGroups,
  nameOf,
  nameValid,
  newSkillFile,
  originText,
  searchHits,
  skillsSearchOf,
  skillsViewOf,
  skillTitle,
} from "./skills-model.ts";

const hash = (n: number) => SkillRevisionHash.make(n.toString(16).padStart(64, "0"));
const AT = "2026-11-06T10:00:00.000Z";
const revision = Revision.make(1);

const skill = (
  id: string,
  name: string,
  description: string,
  latest = hash(1),
  revisions = 1,
  sourceId: string | null = null,
) =>
  new Skill({
    id: SkillId.make(id),
    name: SkillName.make(name),
    description,
    latest,
    revisions,
    sourceId: sourceId === null ? null : SkillSourceId.make(sourceId),
    createdAt: AT,
    updatedAt: AT,
    revision,
  });

const assignment = (id: string, skillId: string, scope: SkillAssignment["scope"], pin = hash(1), held = false) =>
  new SkillAssignment({
    id: SkillAssignmentId.make(id),
    skillId: SkillId.make(skillId),
    scope,
    pin,
    held,
    onlyWhenAsked: false,
    by: { _tag: "You" },
    assignedAt: AT,
    revision,
  });

const pip = { id: AgentId.make("pip"), name: "Pip" } as Agent;
const hobs = new Map([[pip.id, pip]]);

const list = (overrides: Partial<SkillsList> = {}): SkillsList => ({
  skills: [],
  sources: [],
  assignments: [],
  projects: [],
  agentsFolder: { path: null, problems: [] },
  usesThisWeek: [],
  ...overrides,
});

describe("the Skills page's address", () => {
  it("reads every view back from the address it writes", () => {
    const views = [
      { _tag: "Overview" },
      { _tag: "Scope", scope: { _tag: "Hob", agentId: pip.id } },
      { _tag: "Add", from: "file" },
      { _tag: "New" },
      { _tag: "Skill", skillId: SkillId.make("s1"), tab: "history", file: null, diff: hash(2) },
      { _tag: "Skill", skillId: SkillId.make("s1"), tab: null, file: "references/checks.md", diff: null },
      { _tag: "Edit", skillId: SkillId.make("s1") },
      { _tag: "Search", q: "release" },
    ] as const;
    for (const view of views) expect(skillsViewOf(skillsSearchOf(view))).toEqual(view);
  });

  it("opens the overview for an address it cannot read", () => {
    expect(skillsViewOf({ scope: "nowhere" })).toEqual({ _tag: "Overview" });
    expect(skillsViewOf({ q: "   " })).toEqual({ _tag: "Overview" });
  });
});

describe("the library by scope", () => {
  it("groups Everyone, then projects, then hobs, then what no one has yet, pinned to each scope's revision", () => {
    const release = skill("s1", "release-steps", "Releases.", hash(2), 2);
    const commit = skill("s2", "commit-style", "Commits.");
    const loose = skill("s3", "pdf-forms", "Forms.");
    const project = { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/acme/site") } as const;
    const groups = libraryGroups(
      list({
        skills: [release, commit, loose],
        assignments: [
          assignment("a1", "s1", { _tag: "Hob", agentId: pip.id }, hash(1), true),
          assignment("a2", "s1", project, hash(2)),
          assignment("a3", "s2", { _tag: "Everyone" }),
        ],
      }),
      hobs,
    );
    expect(groups.map((group) => group.key)).toEqual(["everyone", "project:github.com/acme/site", "hob:pip", "none"]);
    expect(groups[1]?.rows[0]).toMatchObject({ number: 2 });
    // Pip is kept on an older revision than the newest.
    expect(groups[2]?.rows[0]).toMatchObject({ number: null, assignment: { held: true } });
    expect(groups[3]?.rows.map((row) => row.skill.name)).toEqual(["pdf-forms"]);
  });

  it("says where a skill came from", () => {
    const sources = [
      new SkillSource({
        id: SkillSourceId.make("g"),
        origin: { _tag: "Git", url: "https://github.com/acme/skills.git", ref: "v1.4.0" },
        addedAt: AT,
      }),
    ];
    const [group] = libraryGroups(list({ skills: [skill("s1", "a", "A.", hash(1), 1, "g")], sources }), hobs);
    expect(originText(group?.rows[0]?.origin ?? null)).toBe("github.com/acme/skills · v1.4.0");
    expect(originText(null)).toBe("Written in Hobbots");
    expect(originText({ _tag: "AgentsFolder", path: "/home/me/.agents/skills" })).toBe("~/.agents/skills");
  });
});

describe("skill names, descriptions and files", () => {
  it("reads a name as a title, and a typed title as a name", () => {
    expect(skillTitle("release-steps")).toBe("Release steps");
    expect(nameOf("  Release steps!  ")).toBe("release-steps");
    expect(nameValid("release-steps")).toBe(true);
    expect(nameValid("Release")).toBe(false);
    expect(nameValid("a--b")).toBe(false);
  });

  it("checks a description as you type", () => {
    expect(descriptionState("Releases.")).toBe("short");
    expect(descriptionState("Use when releasing the site: version, changelog, tag.")).toBe("good");
    expect(descriptionState("x".repeat(1025))).toBe("long");
  });

  it("writes a new SKILL.md with its description quoted, and reads the instructions after the front matter", () => {
    const file = newSkillFile("release", 'Use when: "shipping"', "Tag it.");
    expect(file).toBe('---\nname: release\ndescription: "Use when: \\"shipping\\""\n---\n\nTag it.\n');
    expect(instructionsOf(file)).toBe("Tag it.\n");
    // An indented first line opens a code block: it keeps its indentation, so an edit saves it as it was.
    expect(instructionsOf("---\nname: a\ndescription: A.\n---\n\n  \n    git tag v1\n")).toBe("    git tag v1\n");
  });

  it("finds a search in what a skill is for, then in its name", () => {
    const skills = [
      skill("s1", "release-steps", "Use when shipping."),
      skill("s2", "commit-style", "Use when committing."),
    ];
    expect(searchHits(skills, "SHIP")).toMatchObject([{ before: "Use when ", hit: "ship", after: "ping." }]);
    expect(searchHits(skills, "commit style").map((hit) => hit.skill.name)).toEqual(["commit-style"]);
    expect(searchHits(skills, " ")).toEqual([]);
  });

  it("counts the other files a revision added, removed and changed", () => {
    const file = (path: string, sha256: string) => ({ path, mode: "regular" as const, size: 1, sha256 });
    const of = (files: ReadonlyArray<ReturnType<typeof file>>, n: number) =>
      new SkillRevision({
        skillId: SkillId.make("s1"),
        hash: hash(n),
        number: n,
        name: SkillName.make("release"),
        description: "Releases.",
        charms: [],
        files,
        flags: [],
        dropped: [],
        sourceId: null,
        commit: null,
        path: null,
        label: null,
        addedBy: { _tag: "You" },
        addedAt: AT,
      });
    const before = of([file("SKILL.md", "a"), file("a.md", "1"), file("b.md", "2")], 1);
    const after = of([file("SKILL.md", "b"), file("a.md", "9"), file("c.md", "3")], 2);
    expect(fileChanges(after, before)).toEqual({ added: 1, removed: 1, changed: 1 });
  });
});

describe("Export skills", () => {
  // covers ADR 029 (Backups, exports and Diagnostics), #1064
  it("imports an exported skill only when each older revision it brings passed and is still that revision", () => {
    const older = { matches: true, refusal: null };
    const candidate = { refusal: null, existing: null, exported: { older: [older] } };
    expect(importable(candidate)).toBe(true);
    expect(importable({ ...candidate, exported: { older: [{ ...older, matches: false }] } })).toBe(false);
    expect(importable({ ...candidate, exported: { older: [{ ...older, refusal: { check: "front-matter" } }] } })).toBe(
      false,
    );
    expect(importable({ refusal: null, existing: null, exported: null })).toBe(true);
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1064, #1139
  it("opens from its own address and lists each skill once, under the first scope it has, ~/.agents ones apart", () => {
    expect(skillsViewOf({ export: "skills" })).toEqual({ _tag: "Export" });
    expect(skillsSearchOf({ _tag: "Export" })).toEqual({ export: "skills" });
    const site = MemoryProjectIdentity.make("github.com/acme/site");
    const agents = new SkillSource({
      id: SkillSourceId.make("agents"),
      origin: { _tag: "AgentsFolder", path: "/home/me/.agents/skills" },
      addedAt: AT,
    });
    const { rows, notExported } = exportRows(
      list({
        skills: [
          skill("s1", "release-steps", "How releases go", hash(5), 5),
          skill("s2", "commit-style", "How commits read"),
          skill("s3", "support-replies", "How to answer"),
          skill("s4", "pdf-forms", "Forms", hash(1), 1, "agents"),
        ],
        sources: [agents],
        assignments: [
          assignment("a1", "s1", { _tag: "Project", identity: site }, hash(5)),
          assignment("a2", "s1", { _tag: "Hob", agentId: pip.id }, hash(4), true),
          assignment("a3", "s2", { _tag: "Everyone" }),
          assignment("a4", "s4", { _tag: "Everyone" }),
        ],
      }),
      hobs,
    );
    expect(rows.map((row) => [row.skill.name, row.scope?._tag ?? null, row.where])).toEqual([
      ["commit-style", "Everyone", "Everyone"],
      ["release-steps", "Project", "site project +1"],
      ["support-replies", null, "Not given to anyone yet"],
    ]);
    expect(notExported.map((one) => one.name)).toEqual(["pdf-forms"]);
  });

  // covers ADR 029 (~/.agents/skills), #1139
  it("names the ~/.agents/skills folder a skill lives in, and none for a skill of any other source", () => {
    const agents = new SkillSource({
      id: SkillSourceId.make("agents"),
      origin: { _tag: "AgentsFolder", path: "/home/me/.agents/skills" },
      addedAt: AT,
    });
    const pdf = skill("s1", "pdf-forms", "Forms", hash(1), 1, "agents");
    expect(agentsFolderOf(pdf, [agents], [{ path: "pdf" }])).toBe("~/.agents/skills/pdf");
    expect(agentsFolderOf(pdf, [agents])).toBe("~/.agents/skills/pdf-forms");
    expect(agentsFolderOf(skill("s2", "mine", "Mine"), [agents])).toBeNull();
  });

  // covers ADR 029 (Proactive hobs), #1144
  it("offers Draft it with a hob only to hobs that may suggest a skill, Ask included", () => {
    const hob = (name: string, overrides: Agent["policy"]["overrides"]) =>
      ({
        id: AgentId.make(name),
        name,
        policy: { ownFolders: [], hiddenSharedFolders: [], overrides },
      }) as unknown as Agent;
    const active = [hob("Ada", {}), hob("Bram", { "propose-skill": "deny" }), hob("Cleo", { "propose-skill": "ask" })];
    expect(draftingHobs(active, "balanced").map((one) => one.name)).toEqual(["Ada", "Cleo"]);
    expect(draftingHobs(active, "trusting").map((one) => one.name)).toEqual(["Ada", "Cleo"]);
  });
});
