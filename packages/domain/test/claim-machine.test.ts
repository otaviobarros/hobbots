import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Claim,
  type ClaimEvent,
  ClaimId,
  ClaimMachine,
  type ClaimScope,
  type ClaimState,
  ClaimState as ClaimStates,
  Claims,
  claimBranch,
  claimPath,
  claimsClash,
  IllegalClaimTransition,
  numberLike,
  numbersIn,
  pickNumber,
  type TaskId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = "2026-11-11T00:00:00.000Z";

interface ClaimFields {
  readonly id?: string;
  readonly scope?: ClaimScope;
  readonly key?: string;
  readonly taskId?: string;
  readonly state?: ClaimState;
  readonly repository?: string;
}

const claim = (fields: ClaimFields = {}) =>
  new Claim({
    id: ClaimId.make(fields.id ?? "claim-1"),
    scope: fields.scope ?? "path",
    repository: fields.repository ?? "github.com/me/app",
    directory: fields.scope === "migration-number" || fields.scope === "adr-number" ? "docs/decisions" : null,
    key: fields.key ?? "docs/a.md",
    taskId: (fields.taskId ?? "task-1") as TaskId,
    actor: { kind: "hob", id: "hob-1" },
    state: fields.state ?? "held",
    createdAt: at,
    updatedAt: at,
    releasedAt: fields.state === "released" ? at : null,
    revision: 1 as Claim["revision"],
  });

/** What the model tracks of a claim: every field a rule writes. */
interface ClaimView {
  readonly state: ClaimState;
  readonly updatedAt: string;
  readonly releasedAt: string | null;
  readonly numbered: boolean;
}

const view = (c: Claim): ClaimView => ({
  state: c.state,
  updatedAt: c.updatedAt,
  releasedAt: c.releasedAt,
  numbered: c.scope === "migration-number" || c.scope === "adr-number",
});

// The rules of #1388, written apart from the machine so the two can disagree: a number is never
// contested, a released claim never comes back.
const stepModel = (m: ClaimView, e: ClaimEvent): ClaimView | "refused" => {
  switch (e._tag) {
    case "Contest":
      return m.state === "held" && !m.numbered ? { ...m, state: "contested", updatedAt: e.at } : "refused";
    case "Clear":
      return m.state === "contested" ? { ...m, state: "held", updatedAt: e.at } : "refused";
    case "Release":
      return m.state === "released" ? "refused" : { ...m, state: "released", updatedAt: e.at, releasedAt: e.at };
  }
};

const times = fc
  .integer({ min: 0, max: 10_000 })
  .map((minute) => new Date(Date.UTC(2026, 10, 11) + minute * 60_000).toISOString());
const events: fc.Arbitrary<ClaimEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Contest" as const), at: times }),
  fc.record({ _tag: fc.constant("Clear" as const), at: times }),
  fc.record({ _tag: fc.constant("Release" as const), at: times }),
);
const scopes = fc.constantFrom<ClaimScope>("migration-number", "adr-number", "path", "branch");

describe("ClaimMachine", () => {
  it("agrees with a model of contest, clear and release over random runs of events", () => {
    agreesWithModel({
      machine: ClaimMachine,
      records: fc
        .tuple(fc.constantFrom(...ClaimStates.literals), scopes)
        .filter(([state, scope]) => state !== "contested" || scope === "path" || scope === "branch")
        .map(([state, scope]) => claim({ state, scope, key: scope === "path" ? "docs/a.md" : "7" })),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalClaimTransition => result instanceof IllegalClaimTransition,
    });
  });

  it("exports one row per event", () => {
    expect(ClaimMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Contest", ["held"], "contested", true],
      ["Clear", ["contested"], "held", false],
      ["Release", ["held", "contested"], "released", false],
    ]);
  });

  it("never contests a number and never brings a released claim back", () => {
    const number = claim({ scope: "migration-number", key: "97" });
    expect(Claims.transition(number, { _tag: "Contest", at })).toBeInstanceOf(IllegalClaimTransition);
    const released = claim({ state: "released" });
    expect(Claims.transition(released, { _tag: "Clear", at })).toBeInstanceOf(IllegalClaimTransition);
    expect(Claims.can(released, { _tag: "Release", at })).toBe(false);
  });
});

describe("claim rules", () => {
  it("finds a clash on the same path or a path inside it, in the same repository, between two Tasks", () => {
    const mine = claim({ key: "packages/domain" });
    const of = (fields: ClaimFields) => claim({ id: "claim-2", taskId: "task-2", ...fields });
    expect(claimsClash(mine, of({ key: "packages/domain/src/claim.ts" }))).toBe(true);
    expect(claimsClash(mine, of({ key: "packages/domain" }))).toBe(true);
    // Whole names only, another repository, the same Task, and a released claim never clash.
    expect(claimsClash(mine, of({ key: "packages/domain-two" }))).toBe(false);
    expect(claimsClash(mine, of({ key: "packages/domain", repository: "github.com/me/other" }))).toBe(false);
    expect(claimsClash(mine, of({ key: "packages/domain", taskId: "task-1" }))).toBe(false);
    expect(claimsClash(mine, of({ key: "packages/domain", state: "released" }))).toBe(false);
    // A branch clashes only by its whole name; a number never clashes.
    const branch = claim({ scope: "branch", key: "feat/claims" });
    expect(claimsClash(branch, of({ scope: "branch", key: "feat/claims" }))).toBe(true);
    expect(claimsClash(branch, of({ scope: "branch", key: "feat/claims-two" }))).toBe(false);
    expect(claimsClash(branch, of({ scope: "path", key: "feat/claims" }))).toBe(false);
    const number = claim({ scope: "adr-number", key: "37" });
    expect(claimsClash(number, of({ scope: "adr-number", key: "37" }))).toBe(false);
  });

  it("clears a contested claim only once nothing it clashes with is left open", () => {
    const a = claim({ id: "a", taskId: "t-a", state: "contested" });
    const b = claim({ id: "b", taskId: "t-b", state: "contested" });
    const c = claim({ id: "c", taskId: "t-c", state: "contested" });
    expect(Claims.clearedBy([a], [a, b, c])).toEqual([]);
    expect(Claims.clearedBy([a, b], [a, b, c]).map((each) => each.id)).toEqual(["c"]);
  });

  it("hands out the number asked for when it is free, and otherwise one past every number ever held", () => {
    expect(pickNumber({ onMain: [1, 2, 96], claimed: [], asked: null })).toEqual({ number: 97, taken: null });
    expect(pickNumber({ onMain: [1, 2, 96], claimed: [97, 98], asked: null })).toEqual({ number: 99, taken: null });
    expect(pickNumber({ onMain: [96], claimed: [97], asked: 97 })).toEqual({ number: 98, taken: 97 });
    expect(pickNumber({ onMain: [96], claimed: [97], asked: 96 })).toEqual({ number: 98, taken: 96 });
    expect(pickNumber({ onMain: [96], claimed: [97], asked: 120 })).toEqual({ number: 120, taken: null });
    expect(pickNumber({ onMain: [], claimed: [], asked: null })).toEqual({ number: 1, taken: null });
  });

  it("reads numbers from file names and writes one as they do", () => {
    const names = ["0095_thread_kinds.ts", "0096_memory.ts", "index.ts", "README.md"];
    expect(numbersIn(names)).toEqual([95, 96]);
    expect(numberLike(97, names)).toBe("0097");
    expect(numberLike(38, ["037-chat-and-camps.md", "README.md"])).toBe("038");
    expect(numberLike(12, ["9-a.md", "10-b.md"])).toBe("12");
  });

  it("keys paths inside the repository and branches by their name", () => {
    expect(claimPath("./docs//decisions/")).toBe("docs/decisions");
    expect(claimPath("docs\\a.md")).toBe("docs/a.md");
    for (const outside of ["/etc/passwd", "../up", "a/../../b", "C:/x", "~/x", " ", "."]) {
      expect(claimPath(outside)).toBeNull();
    }
    expect(claimBranch("refs/heads/feat/claims")).toBe("feat/claims");
    expect(claimBranch("two words")).toBeNull();
    expect(claimBranch("  ")).toBeNull();
  });

  it("splits a long path in linear time", () => {
    const long = `${"a/".repeat(50_000)}b`;
    expect(claimPath(long)?.endsWith("/b")).toBe(true);
  });
});
