import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  type CharmOperationId,
  HobProposal,
  type HobProposalEvent,
  HobProposalId,
  HobProposalMachine,
  type HobProposalRow,
  type HobProposalRowEvent,
  HobProposalRowMachine,
  HobProposalRowState,
  HobProposalRows,
  type HobProposalState,
  HobProposalStates,
  IllegalHobProposalRowTransition,
  IllegalHobProposalTransition,
  type SummoningDraft,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();
const times = fc.integer({ min: 0, max: 10_000 }).map(at);

const DRAFT = { name: "Quill" } as unknown as SummoningDraft;

const row = (id: string, state: HobProposalRowState): HobProposalRow => ({
  id,
  hobId: AgentId.make("hob-2"),
  label: "Quill",
  draft: null,
  change: null,
  before: null,
  configVersion: null,
  status: null,
  runningReplies: null,
  edited: null,
  state,
  outcome: state === "allowed" || state === "failed" ? "Done." : null,
  decidedAt: state === "pending" ? null : at(1),
});

/** What the model tracks of a row: every field a rule writes. */
interface RowView {
  readonly state: HobProposalRowState;
  readonly edited: SummoningDraft | null;
  readonly outcome: string | null;
  readonly decidedAt: string | null;
}

const rowView = (r: HobProposalRow): RowView => ({
  state: r.state,
  edited: r.edited,
  outcome: r.outcome,
  decidedAt: r.decidedAt,
});

// ADR 034's rows, written apart from the machine so the two can disagree: you allow or deny a row
// that waits; an allowed row is made, fails, or goes back to you; a decided row stays decided.
const stepRow = (m: RowView, e: HobProposalRowEvent): RowView | "refused" => {
  switch (e._tag) {
    case "Allow":
      return m.state === "pending" ? { ...m, state: "applying", edited: e.edited, decidedAt: e.at } : "refused";
    case "Deny":
      return m.state === "pending" ? { ...m, state: "denied", outcome: null, decidedAt: e.at } : "refused";
    case "Made":
      return m.state === "applying" ? { ...m, state: "allowed", outcome: e.outcome } : "refused";
    case "Failed":
      return m.state === "applying" ? { ...m, state: "failed", outcome: e.outcome } : "refused";
    case "Reopen":
      return m.state === "applying" ? { state: "pending", edited: null, outcome: null, decidedAt: null } : "refused";
  }
};

const outcomes = fc.constantFrom("Summoned Quill.", "Quill's name is taken.");
const rowEvents: fc.Arbitrary<HobProposalRowEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Allow" as const), edited: fc.constantFrom(null, DRAFT), at: times }),
  fc.record({ _tag: fc.constant("Deny" as const), at: times }),
  fc.record({ _tag: fc.constant("Made" as const), outcome: outcomes }),
  fc.record({ _tag: fc.constant("Failed" as const), outcome: outcomes }),
  fc.record({ _tag: fc.constant("Reopen" as const) }),
);
const states = fc.constantFrom(...HobProposalRowState.literals);

const proposal = (state: HobProposalState, rows: ReadonlyArray<HobProposalRow>) =>
  new HobProposal({
    id: HobProposalId.make("proposal-1"),
    agentId: AgentId.make("hob-1"),
    kind: "summon",
    tool: "summoning_summon",
    call: { scope: "task:task-1", key: "key" },
    threadId: null,
    messageId: null,
    taskId: null,
    stepId: null,
    rows: [...rows],
    asks: [],
    safety: null,
    highRisk: false,
    alwaysAllowed: [],
    state,
    createdAt: at(0),
    updatedAt: at(0),
    settledAt: state === "settled" ? at(1) : null,
  });

/** What the model tracks of a proposal: every field a rule writes. */
interface ProposalView {
  readonly state: HobProposalState;
  readonly rows: ReadonlyArray<HobProposalRowState>;
  readonly alwaysAllowed: ReadonlyArray<string>;
  readonly updatedAt: string;
  readonly settledAt: string | null;
}

const proposalView = (p: HobProposal): ProposalView => ({
  state: p.state,
  rows: p.rows.map((each) => each.state),
  alwaysAllowed: p.alwaysAllowed,
  updatedAt: p.updatedAt,
  settledAt: p.settledAt,
});

// A proposal settles once no row waits or is being made, and a settled one never changes again.
const stepProposal = (m: ProposalView, e: HobProposalEvent): ProposalView | "refused" => {
  if (m.state !== "open") return "refused";
  const rows = e.rows.map((each) => each.state);
  const settles = rows.every((state) => state === "allowed" || state === "denied" || state === "failed");
  return {
    state: settles ? "settled" : "open",
    rows,
    alwaysAllowed: e.alwaysAllowed,
    updatedAt: e.at,
    settledAt: settles ? e.at : m.settledAt,
  };
};

const rowLists = fc.array(states, { minLength: 1, maxLength: 4 }).map((list) => list.map((s, i) => row(`row-${i}`, s)));
const proposalEvents: fc.Arbitrary<HobProposalEvent> = fc.record({
  _tag: fc.constant("Update" as const),
  rows: rowLists,
  alwaysAllowed: fc.subarray<CharmOperationId>(["summoning.summon", "summoning.change"]),
  at: times,
});

describe("HobProposalRowMachine", () => {
  it("agrees with a model of allow, deny, made, failed and reopen over random runs of events", () => {
    agreesWithModel({
      machine: HobProposalRowMachine,
      records: states.map((state) => row("row-1", state)),
      events: rowEvents,
      model: { init: rowView, step: stepRow, view: rowView },
      isError: (result): result is IllegalHobProposalRowTransition => result instanceof IllegalHobProposalRowTransition,
    });
  });

  it("exports one row per rule", () => {
    expect(HobProposalRowMachine.table.map((rule) => [rule.event, rule.from, rule.to, rule.guarded])).toEqual([
      ["Allow", ["pending"], "applying", false],
      ["Deny", ["pending"], "denied", false],
      ["Made", ["applying"], "allowed", false],
      ["Failed", ["applying"], "failed", false],
      ["Reopen", ["applying"], "pending", false],
    ]);
  });

  it("counts a row decided only once it is allowed, denied or failed", () => {
    expect(HobProposalRowState.literals.filter((state) => HobProposalRows.isDecided(row("r", state)))).toEqual([
      "allowed",
      "denied",
      "failed",
    ]);
  });
});

describe("HobProposalMachine", () => {
  it("agrees with a model that settles once every row is decided, over random runs of events", () => {
    agreesWithModel({
      machine: HobProposalMachine,
      records: fc
        .tuple(fc.constantFrom<HobProposalState>("open", "settled"), rowLists)
        .map(([state, rows]) => proposal(state, rows)),
      events: proposalEvents,
      model: { init: proposalView, step: stepProposal, view: proposalView },
      isError: (result): result is IllegalHobProposalTransition => result instanceof IllegalHobProposalTransition,
    });
  });

  it("tells whether a proposal made anything", () => {
    expect(HobProposalStates.madeAny(proposal("settled", [row("a", "denied"), row("b", "allowed")]))).toBe(true);
    expect(HobProposalStates.madeAny(proposal("settled", [row("a", "denied"), row("b", "failed")]))).toBe(false);
  });
});
