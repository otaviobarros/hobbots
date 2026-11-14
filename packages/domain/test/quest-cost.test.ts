import { describe, expect, it } from "vitest";
import { Criterion, CriterionId, type CriterionState, QuestId, questCost } from "../src/index.ts";

const criterion = (state: CriterionState, index: number) =>
  new Criterion({
    id: CriterionId.make(`criterion-${index}`),
    text: `Criterion ${index}`,
    required: true,
    taskIds: [],
    state,
    evidence: [],
    decided:
      state === "open"
        ? null
        : { by: { kind: "hob", id: "aldric" }, reason: "Checked", at: "2026-11-14T00:00:00.000Z" },
  });

const QUEST = QuestId.make("quest-1");
const spend = { tokens: 125_000, turns: 9, unreported: 1 };

describe("cost per accepted outcome (#1449)", () => {
  it("divides what the party spent by the criteria accepted on evidence, never the waived ones", () => {
    const criteria = (["accepted", "waived", "accepted", "needs-rework", "open"] as const).map(criterion);
    expect(questCost(QUEST, spend, criteria)).toEqual({
      questId: QUEST,
      tokens: 125_000,
      turns: 9,
      unreported: 1,
      accepted: 2,
      criteria: 5,
      perAccepted: 62_500,
    });
    expect(
      questCost(QUEST, { ...spend, tokens: 100 }, criteria.slice(0, 3).concat(criterion("accepted", 9))).perAccepted,
    ).toBe(33);
  });

  it("has no cost per outcome while nothing is accepted, or the Quest has no criteria", () => {
    expect(questCost(QUEST, spend, [criterion("waived", 1), criterion("open", 2)]).perAccepted).toBeNull();
    expect(questCost(QUEST, spend, [])).toMatchObject({ accepted: 0, criteria: 0, perAccepted: null });
  });
});
