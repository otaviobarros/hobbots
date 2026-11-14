import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
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
  clashGroups,
  IllegalClaimTransition,
  numberLike,
  numbersIn,
  pickNumber,
  type TaskId,
  touchesPath,
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
    directory: fields.scope === "sequence" ? "docs/decisions" : null,
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
  readonly actor: string;
}

const view = (c: Claim): ClaimView => ({
  state: c.state,
  updatedAt: c.updatedAt,
  releasedAt: c.releasedAt,
  numbered: c.scope === "sequence",
  actor: `${c.actor.kind}:${c.actor.id}`,
});

// The rules of #1388, written apart from the machine so the two can disagree: a number is never
// contested, a released claim never comes back. #1449: only you take a claim over, held or
// contested, and it is yours until its Task ends.
const stepModel = (m: ClaimView, e: ClaimEvent): ClaimView | "refused" => {
  switch (e._tag) {
    case "Contest":
      return m.state === "held" && !m.numbered ? { ...m, state: "contested", updatedAt: e.at } : "refused";
    case "Clear":
      return m.state === "contested" ? { ...m, state: "held", updatedAt: e.at } : "refused";
    case "TakeOver":
      return (m.state === "held" || m.state === "contested") && e.by.kind === "user"
        ? { ...m, state: "taken", updatedAt: e.at, actor: `${e.by.kind}:${e.by.id}` }
        : "refused";
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
  fc.record({
    _tag: fc.constant("TakeOver" as const),
    at: times,
    by: fc.record({
      kind: fc.constantFrom<Actor["kind"]>("user", "hob", "hub"),
      id: fc.constantFrom("owner", "hob-2"),
    }),
  }),
);
const scopes = fc.constantFrom<ClaimScope>("sequence", "path", "branch");

describe("ClaimMachine", () => {
  it("agrees with a model of contest, clear, take over and release over random runs of events", () => {
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
      ["TakeOver", ["held", "contested"], "taken", true],
      ["Release", ["held", "contested", "taken"], "released", false],
    ]);
  });

  it("never contests a number and never brings a released claim back", () => {
    const number = claim({ scope: "sequence", key: "97" });
    expect(Claims.transition(number, { _tag: "Contest", at })).toBeInstanceOf(IllegalClaimTransition);
    const released = claim({ state: "released" });
    expect(Claims.transition(released, { _tag: "Clear", at })).toBeInstanceOf(IllegalClaimTransition);
    expect(Claims.can(released, { _tag: "Release", at })).toBe(false);
  });
});

describe("taking a claim over (#1449)", () => {
  it("moves a held or contested claim to you, never to a hob, and keeps it clashing", () => {
    const you: Actor = { kind: "user", id: "owner" };
    for (const state of ["held", "contested"] as const) {
      const taken = Claims.transition(claim({ state }), { _tag: "TakeOver", at, by: you });
      expect(taken).toBeInstanceOf(Claim);
      expect(Claims.isTaken(taken as Claim)).toBe(true);
      expect((taken as Claim).actor).toEqual(you);
    }
    expect(Claims.can(claim(), { _tag: "TakeOver", at, by: { kind: "hob", id: "hob-2" } })).toBe(false);
    const taken = claim({ state: "taken" });
    expect(Claims.contestable(taken)).toBe(false);
    expect(claimsClash(taken, claim({ id: "claim-2", taskId: "task-2" }))).toBe(true);
    expect(Claims.can(taken, { _tag: "Release", at })).toBe(true);
  });

  it("finds the writes a path claim covers: the file, inside its folder, or a folder holding it", () => {
    const folder = claim({ key: "web/shop" });
    expect(touchesPath(folder, "web/shop/cart.ts")).toBe(true);
    expect(touchesPath(folder, "web/shop")).toBe(true);
    expect(touchesPath(folder, "web")).toBe(true);
    expect(touchesPath(folder, "web/shopping.ts")).toBe(false);
    expect(touchesPath(claim({ scope: "branch", key: "web/shop" }), "web/shop")).toBe(false);
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
    const number = claim({ scope: "sequence", key: "37" });
    expect(claimsClash(number, of({ scope: "sequence", key: "37" }))).toBe(false);
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

describe("Heads-up clashes (#1390)", () => {
  const paths = fc.constantFrom("web", "web/badge.png", "web/shop.css", "docs", "docs/a.md");
  const claims = fc
    .array(
      fc.record({
        key: paths,
        taskId: fc.constantFrom("task-1", "task-2", "task-3"),
        state: fc.constantFrom<ClaimState>("held", "contested", "released"),
      }),
      { maxLength: 8 },
    )
    .map((fields) => fields.map((each, index) => claim({ ...each, id: `claim-${index}` })));

  it("[TC-OR-1390-01] puts each clash touching the thread's claims in one group, once, and nothing else", () => {
    fc.assert(
      fc.property(claims, fc.integer({ min: 0, max: 8 }), (open, cut) => {
        const ours = open.slice(0, cut);
        const groups = clashGroups(ours, open);
        const seen = groups.flat().map((each) => each.id);
        // Each claim is in one group at most, and every group is open claims that all connect.
        expect(new Set(seen).size).toBe(seen.length);
        for (const group of groups) {
          expect(group.length).toBeGreaterThanOrEqual(2);
          expect(group.every(Claims.isOpen)).toBe(true);
          expect(group.some((each) => ours.some((mine) => mine.id === each.id))).toBe(true);
          for (const each of group) expect(group.some((other) => claimsClash(each, other))).toBe(true);
        }
        // Every open claim of ours that clashes with any open claim is in a group.
        for (const mine of ours) {
          if (open.some((other) => claimsClash(mine, other))) expect(seen).toContain(mine.id);
        }
      }),
    );
  });

  it("[TC-OR-1390-02] makes one clash of two Tasks on one file, and one of a folder and the files inside it", () => {
    const badge = claim({ id: "a", taskId: "task-1", key: "web/badge.png", state: "contested" });
    const review = claim({ id: "b", taskId: "task-2", key: "web", state: "contested" });
    const css = claim({ id: "c", taskId: "task-3", key: "web/shop.css", state: "contested" });
    const docs = claim({ id: "d", taskId: "task-3", key: "docs" });
    expect(clashGroups([badge], [badge, review, css, docs]).map((group) => group.map((each) => each.id))).toEqual([
      ["a", "b", "c"],
    ]);
    expect(clashGroups([docs], [badge, review, css, docs])).toEqual([]);
  });
});
