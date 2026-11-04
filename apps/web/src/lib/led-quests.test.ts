import { describe, expect, it } from "vitest";
import { ledQuests } from "./led-quests.ts";

const group = (id: string, leadId: string, states: ReadonlyArray<string>) =>
  ({
    quest: { id, leadId },
    threadAgentId: leadId,
    members: states.map((state) => ({ task: { state } })),
  }) as never;

describe("ledQuests", () => {
  it("keeps the hob's own Quests, those that need you first, and counts the finished ones", () => {
    const { live, finished } = ledQuests(
      [
        group("calm", "aldric", ["completed", "active"]),
        group("other", "pip", ["blocked"]),
        group("urgent", "aldric", ["blocked", "blocked", "completed"]),
        group("done", "aldric", ["completed", "completed"]),
      ],
      "aldric" as never,
    );
    expect(live.map((q) => [q.group.quest.id, q.done, q.total, q.needs])).toEqual([
      ["urgent", 1, 3, 2],
      ["calm", 1, 2, 0],
    ]);
    expect(finished).toBe(1);
  });
});
