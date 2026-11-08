import {
  AgentId,
  HobProposal,
  HobProposalId,
  type HobProposalRow,
  Revision,
  type SummoningDraft,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  allowableRows,
  alwaysOffers,
  changeLines,
  createdHobs,
  editedSummoningDraft,
  hobProposalWhat,
  operationWords,
  summonFacts,
  summonFormDraft,
} from "./hob-proposal-model.ts";

const bram = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000b1");
const ada = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000a1");
const fay = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000f1");

const row = (fields: Partial<HobProposalRow> = {}): HobProposalRow => ({
  id: "1",
  hobId: ada,
  label: "Ada",
  draft: null,
  change: null,
  before: null,
  configVersion: null,
  status: null,
  runningReplies: null,
  edited: null,
  state: "pending",
  outcome: null,
  decidedAt: null,
  ...fields,
});

const proposal = (fields: Partial<HobProposal> = {}) =>
  new HobProposal({
    id: HobProposalId.make("hp1"),
    agentId: bram,
    kind: "summon",
    tool: "summoning_summon",
    call: { scope: "reply:m1", key: "k1" },
    threadId: null,
    messageId: null,
    taskId: null,
    stepId: null,
    rows: [row()],
    asks: ["summoning.summon"],
    safety: null,
    highRisk: false,
    alwaysAllowed: [],
    state: "open",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    settledAt: null,
    revision: Revision.make(1),
    ...fields,
  });

const draft: SummoningDraft = {
  name: "Ada",
  role: "researcher",
  good_at: "Finding sources",
  runtime: "codex",
  model: "gpt-5",
  effort: "high",
  own_folders: ["/work/notes"],
  charms: ["web"],
  look_seed: 42,
  look_color: "moss",
  instructions: "Read widely.",
};

describe("hob proposal card", () => {
  it("says what a proposal asks, by its kind", () => {
    expect(hobProposalWhat(proposal({ rows: [row(), row({ id: "2" }), row({ id: "3" })] }), "Bram")).toBe(
      "Bram proposes 3 new hobs",
    );
    expect(hobProposalWhat(proposal({ kind: "change", rows: [row(), row({ id: "2" })] }), "Bram")).toBe(
      "Bram proposes changes to 2 hobs",
    );
    expect(hobProposalWhat(proposal({ kind: "change", rows: [row({ hobId: bram })] }), "Bram")).toBe(
      "Bram proposes changes to itself",
    );
    expect(hobProposalWhat(proposal({ kind: "retire" }), "Bram")).toBe("Bram proposes retiring Ada");
  });

  it("lists a new hob's role, good at, brain, folders, Charms and answers", () => {
    expect(summonFacts(draft)).toEqual([
      ["Role", "Researcher"],
      ["Good at", "Finding sources"],
      ["Brain", "Codex · gpt-5 · high"],
      ["Folders", "/work/notes"],
      ["Charms", "web"],
      ["Answers", "The manager's own"],
    ]);
  });

  it("shows a change as before and after, field by field", () => {
    const changed = row({
      change: { hob: "Ada", name: "Ada Lovelace", effort: "low", instructions: "New." },
      before: { name: "Ada", effort: "high", instructions: "Old." },
    });
    expect(changeLines(changed)).toEqual([
      { key: "name", label: "Name", before: "Ada", after: "Ada Lovelace", long: false },
      { key: "effort", label: "Effort", before: "high", after: "low", long: false },
      { key: "instructions", label: "Instructions", before: "Old.", after: "New.", long: true },
    ]);
  });

  it("offers Allow only for pending rows whose hob did not change since", () => {
    const rows = [row(), row({ id: "2" }), row({ id: "3", state: "denied" })];
    expect(allowableRows(proposal({ rows }), ["2"]).map((r) => r.id)).toEqual(["1"]);
  });

  it("offers Always allow for each operation that asked and is not set yet, while open", () => {
    const asks = ["summoning.summon", "summoning.brain"] as const;
    expect(alwaysOffers(proposal({ asks: [...asks], alwaysAllowed: ["summoning.summon"] }))).toEqual([
      "summoning.brain",
    ]);
    expect(alwaysOffers(proposal({ asks: [...asks], state: "settled" }))).toEqual([]);
    expect(operationWords("summoning.summon")).toBe("summoning new hobs");
  });

  it("makes a created card for each summon row you allowed, your version's name first", () => {
    const rows = [
      row({ draft, state: "allowed" }),
      row({ id: "2", hobId: fay, label: "Fay", draft: { name: "Fay" }, edited: { name: "Flo" }, state: "allowed" }),
      row({ id: "3", state: "denied", draft }),
    ];
    expect(createdHobs(proposal({ rows })).map(({ hobId, name }) => ({ hobId, name }))).toEqual([
      { hobId: ada, name: "Ada" },
      { hobId: fay, name: "Flo" },
    ]);
    expect(createdHobs(proposal({ kind: "change", rows }))).toEqual([]);
  });

  it("opens a summon row in Summon and brings your version back, keeping what Summon does not show", () => {
    const summonRow = row({ draft });
    const form = summonFormDraft(summonRow);
    expect(form).toMatchObject({
      id: ada,
      name: "Ada",
      role: "researcher",
      goodAt: "Finding sources",
      lookSeed: 42,
      lookColor: "moss",
      runtime: "codex",
      model: "gpt-5",
      effort: "high",
      chores: "Read widely.",
    });
    const edited = editedSummoningDraft({ ...form, name: "Ada Two ", effort: "low" }, summonRow);
    expect(edited).toMatchObject({
      name: "Ada Two",
      role: "researcher",
      effort: "low",
      own_folders: ["/work/notes"],
      charms: ["web"],
      instructions: "Read widely.",
    });
    expect("answers" in edited).toBe(false);
  });
});
