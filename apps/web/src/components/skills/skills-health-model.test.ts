import type { SkillHealth } from "@hobbots/api";
import { type Agent, AgentId, SkillAssignmentId, SkillId, SkillName, SkillRevisionHash } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { healthItems, loadRows } from "./skills-health-model.ts";

const pip = { id: AgentId.make("pip"), name: "Pip" } as Agent;
const quill = { id: AgentId.make("quill"), name: "Quill" } as Agent;
const hobs = new Map([
  [pip.id, pip],
  [quill.id, quill],
]);
const release = SkillId.make("release");
const R1 = SkillRevisionHash.make("1".repeat(64));
const empty: SkillHealth = { unused: [], behind: [], clashes: [], descriptions: [], loads: [] };
const NOW = new Date("2026-11-08T00:00:00.000Z");

describe("the Skills Overview's health checks (ADR 029, Health checks)", () => {
  // covers ADR 029 (Health checks), #1099
  it("[TC-UI-1099-01] puts what keeps a hob worse off first, each line opening where you act on it", () => {
    const items = healthItems(
      {
        ...empty,
        unused: [
          { skillId: release, name: SkillName.make("release"), lastUsedAt: "2026-09-01T00:00:00.000Z", assignments: 2 },
        ],
        behind: [
          {
            assignmentId: SkillAssignmentId.make("a1"),
            skillId: release,
            name: SkillName.make("release"),
            scope: { _tag: "Hob", agentId: quill.id },
            pin: R1,
            number: 1,
            latest: 2,
            held: true,
          },
        ],
        clashes: [{ agentId: pip.id, name: SkillName.make("deploy"), kind: "projects", skillIds: [] }],
        descriptions: [
          {
            skillId: release,
            name: SkillName.make("plan"),
            set: SkillName.make("playbook"),
            problem: "vague",
            length: 9,
          },
        ],
      },
      hobs,
      NOW,
    );
    expect(items.map((one) => [one.tone, one.title])).toEqual([
      ["warn", "Two of Pip's projects have a “Deploy”"],
      ["warn", "Release was not used in 68 days"],
      ["info", "Quill is on Release r1"],
      ["info", "Plan's description may not trigger"],
    ]);
    expect(items.map((one) => one.to)).toEqual([
      { _tag: "Scope", scope: { _tag: "Hob", agentId: pip.id } },
      { _tag: "Skill", skillId: release, member: null, tab: "who", file: null, diff: null },
      { _tag: "Skill", skillId: release, member: null, tab: "who", file: null, diff: null },
      { _tag: "Skill", skillId: release, member: "plan", tab: null, file: null, diff: null },
    ]);
    expect(items[2]?.hint).toBe("Kept there while r2 is the newest. Move it when you are ready.");
  });

  it("[TC-UI-1099-02] shows what each hob carries, the most loaded first, heavy past 75% or 30 skills", () => {
    const rows = loadRows(
      {
        ...empty,
        loads: [
          { agentId: pip.id, runtime: "claude-code", skills: 3, characters: 800, budget: 8000 },
          { agentId: quill.id, runtime: "codex", skills: 4, characters: 6400, budget: 8000 },
          { agentId: AgentId.make("gone"), runtime: "codex", skills: 31, characters: 80, budget: 8000 },
          { agentId: AgentId.make("bare"), runtime: "codex", skills: 0, characters: 0, budget: 8000 },
        ],
      },
      hobs,
    );
    expect(rows.map((one) => [one.name, one.count, one.percent, one.heavy])).toEqual([
      ["Quill", 4, 80, true],
      ["Pip", 3, 10, false],
      ["A hob", 31, 1, true],
    ]);
  });
});
