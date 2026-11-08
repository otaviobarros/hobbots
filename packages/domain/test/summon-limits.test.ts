import { describe, expect, it } from "vitest";
import { unattendedSummonsBy, unattendedSummonsIn } from "../src/summoning.ts";

const hob = (fields: {
  readonly status?: string;
  readonly summonedBy?: string | null;
  readonly summonedFor?: string | null;
  readonly summonedUnattended?: boolean;
}) => ({ status: "active", summonedBy: "chief", summonedFor: null, summonedUnattended: true, ...fields });

describe("the caps on unattended summons", () => {
  it("count only live hobs a manager summoned without a card, so retiring one frees its place", () => {
    const hobs = [
      hob({}),
      hob({ status: "paused" }),
      hob({ status: "retired" }),
      hob({ summonedUnattended: false }),
      hob({ summonedBy: "other" }),
      hob({ summonedBy: null, summonedUnattended: false }),
    ];
    expect(unattendedSummonsBy(hobs, "chief")).toBe(2);
    expect(unattendedSummonsBy(hobs, "other")).toBe(1);
  });

  it("count a Task tree's live hobs summoned without a card, by any manager", () => {
    const hobs = [
      hob({ summonedFor: "root" }),
      hob({ summonedFor: "step", summonedBy: "other" }),
      hob({ summonedFor: "step", status: "retired" }),
      hob({ summonedFor: "step", summonedUnattended: false }),
      hob({ summonedFor: "elsewhere" }),
      hob({}),
    ];
    expect(unattendedSummonsIn(hobs, new Set(["root", "step"]))).toBe(2);
    expect(unattendedSummonsIn(hobs, new Set())).toBe(0);
  });
});
