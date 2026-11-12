import { describe, expect, it } from "vitest";
import { ledQuests } from "./led-quests.ts";

const group = (id: string, leadId: string) => ({ quest: { id, leadId }, threadAgentId: leadId, members: [] }) as never;

const summary = (questId: string, done: number, working: number, needsYou: number) =>
  [questId, { questId, tones: { needs: 0, working, waiting: 0, done, problem: 0, idle: 0 }, needsYou }] as never;

describe("ledQuests", () => {
  it("keeps the hob's own Quests, those that need you first, and counts the finished ones, as the hub summed them", () => {
    const { live, finished } = ledQuests(
      [group("calm", "aldric"), group("other", "pip"), group("urgent", "aldric"), group("done", "aldric")],
      new Map([
        summary("calm", 1, 1, 0),
        summary("other", 0, 1, 1),
        summary("urgent", 1, 2, 2),
        summary("done", 2, 0, 0),
      ]),
      "aldric" as never,
    );
    expect(live.map((q) => [q.group.quest.id, q.done, q.total, q.needs])).toEqual([
      ["urgent", 1, 3, 2],
      ["calm", 1, 2, 0],
    ]);
    expect(finished).toBe(1);
  });

  it("waits for a Quest's summary before it lists the Quest", () => {
    const { live, finished } = ledQuests([group("calm", "aldric")], new Map(), "aldric" as never);
    expect([live, finished]).toEqual([[], 0]);
  });
});
