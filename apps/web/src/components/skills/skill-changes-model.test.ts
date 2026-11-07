import type { SkillChange } from "@hobbots/api";
import { type Agent, AgentId, SkillAssignmentId, SkillId, SkillName, SkillRevisionHash } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { canRollBack, changeDay, changesByDay, changeText } from "./skill-changes-model.ts";

const now = new Date(2026, 10, 7, 12, 0);
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
const bram = AgentId.make("bram");
const hobs = new Map([[bram, { id: bram, name: "Bram" } as Agent]]);

const change = (overrides: Partial<SkillChange>): SkillChange => ({
  at: at(7, 9),
  kind: "saved",
  skillId: SkillId.make("release"),
  name: SkillName.make("release-steps"),
  number: 2,
  scopes: [],
  held: [],
  moved: [],
  previous: null,
  previousNumber: null,
  agentId: null,
  by: { _tag: "You" },
  ...overrides,
});

describe("What changed (ADR 029, The Skills page)", () => {
  // covers ADR 029 (The Skills page, Pins and rollout), #1062
  it("[TC-UI-1062-03] says each change by day, with what a save moved and held, and Roll back only where there is a way back", () => {
    const saved = change({
      scopes: [{ _tag: "Everyone" }],
      held: [{ _tag: "Hob", agentId: bram }],
      moved: [SkillAssignmentId.make("a")],
      previous: SkillRevisionHash.make("1".repeat(64)),
      previousNumber: 1,
    });
    expect(changeText(saved, hobs)).toEqual({
      kind: "You saved",
      line: "Release steps r2, rolled out to 1 place",
      note: "Kept Bram on its revision",
    });
    expect(canRollBack(saved)).toBe(true);
    expect(canRollBack(change({ previous: SkillRevisionHash.make("1".repeat(64)) }))).toBe(false);

    const back = change({ kind: "rolledOut", number: 1, previousNumber: 2, scopes: [{ _tag: "Everyone" }] });
    expect(changeText(back, hobs)).toMatchObject({
      kind: "Rolled back",
      line: "Release steps moved from r2 to r1 for Everyone",
    });
    expect(changeText(change({ kind: "optedOut", agentId: bram }), hobs).line).toBe("Release steps is off for Bram");

    expect(changeDay(at(7, 8), now)).toBe("Today");
    expect(changeDay(at(6, 20), now)).toBe("Yesterday");
    const days = changesByDay([change({ at: at(7, 9) }), change({ at: at(7, 8) }), change({ at: at(6, 8) })], now);
    expect(days.map((one) => [one.day, one.changes.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});
