import { Quest, Task, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, blackFriday, CAMPAIGN, COPY, QUILL, task, tree } from "../../test/quests.ts";
import { type QuestProgress, questProgress } from "../quest/quest-progress.ts";
import { workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { questTicket } from "./ticket-model.ts";

/** The Black Friday Quest with its Tasks changed: each entry replaces the Task with that id. */
const withTasks = (...tasks: ReadonlyArray<Task>) => {
  const quest = blackFriday();
  return tree({ ...quest, tasks: quest.tasks.map((each) => tasks.find((next) => next.id === each.id) ?? each) });
};

/** What the hub published for a Quest: `done` of `total` Tasks done, and `needs` things waiting on you. */
const published = (done: number, total: number, needs = 0): QuestProgress => ({ segments: [], done, total, needs });

/** A Task that ended `minutes` after it started. */
const ended = (base: Task, state: Task["state"], minutes: number) =>
  new Task({ ...base, state, updatedAt: new Date(Date.parse(base.createdAt) + minutes * 60_000).toISOString() });

describe("questTicket", () => {
  it("shows the party in lane order, with the progress the hub published", () => {
    const ticket = questTicket(
      withTasks(task(COPY, { ownerId: QUILL, state: "completed", second: 2 })),
      published(1, 2),
    );
    expect(ticket?.title).toBe("Plan a Black Friday campaign");
    expect(ticket?.leadId).toBe(ALDRIC);
    expect(ticket?.party.map((member) => [member.hobId, member.status])).toEqual([
      [ALDRIC, "running"],
      [QUILL, "done"],
      [ADA, "waiting"],
    ]);
    expect(ticket?.progress).toEqual({ kind: "count", done: 1, total: 2 });
    expect(ticket?.needsYou).toBe(0);
    expect(messages.progress(ticket?.progress ?? { kind: "count", done: 0, total: 0 })).toBe("1 of 2 done");
  });

  it("says how many things the hub counts as waiting on you", () => {
    expect(questTicket(blackFriday(), published(0, 2, 2))?.needsYou).toBe(2);
    expect(messages.needsYou(2)).toBe("2 need you");
    expect(messages.needsYou(1)).toBe("1 needs you");
  });

  it("says when a Task working alone started", () => {
    const solo = tree({ tasks: [task(CAMPAIGN, { brief: "Tidy the notes" })] });
    const ticket = questTicket(solo, questProgress(solo, undefined));
    expect(ticket?.party.map((member) => member.hobId)).toEqual([ALDRIC]);
    expect(ticket?.progress).toEqual({ kind: "started", at: task(CAMPAIGN).createdAt });
  });

  it("keeps one sprite per hob when a hob has steps or more than one Task", () => {
    const steps = ["outline", "draft"].map((id, index) => task(TaskId.make(id), { second: index + 1 }));
    const alone = tree({ tasks: [task(CAMPAIGN), ...steps] });
    const ticket = questTicket(alone, questProgress(alone, undefined));
    expect(ticket?.party.map((member) => member.hobId)).toEqual([ALDRIC]);
    expect(ticket?.progress).toEqual({ kind: "count", done: 0, total: 2 });
  });

  it("says how the work ended and how long it ran, and asks nothing more of you", () => {
    const top = task(CAMPAIGN, { brief: "Plan a Black Friday campaign" });
    const done = questTicket(withTasks(ended(top, "completed", 18)), published(2, 2));
    expect(done?.progress).toEqual({ kind: "ended", end: "completed", took: 18 * 60_000 });
    expect(messages.progress(done?.progress ?? { kind: "count", done: 0, total: 0 })).toBe("Finished in 18 min");

    const failed = questTicket(
      withTasks(ended(top, "failed", 4), task(COPY, { ownerId: QUILL, state: "failed" })),
      published(0, 2),
    );
    expect(failed?.needsYou).toBe(0);
    expect(messages.progress(failed?.progress ?? { kind: "count", done: 0, total: 0 })).toBe("Failed after 4 min");

    const cancelled = questTicket(withTasks(ended(top, "cancelled", 2)), published(0, 2));
    expect(messages.progress(cancelled?.progress ?? { kind: "count", done: 0, total: 0 })).toBe(
      "Cancelled after 2 min",
    );
  });

  it("keeps the time the Quest ended when its lead's turn ends after it (#1007)", () => {
    const top = ended(task(CAMPAIGN, { brief: "Plan a Black Friday campaign" }), "completed", 17);
    const endedAt = top.updatedAt;
    const later = new Task({ ...top, updatedAt: new Date(Date.parse(endedAt) + 4_000).toISOString() });
    const finished = (each: Task) => {
      const base = withTasks(each);
      const [record] = base.quests;
      if (record === undefined) throw new Error("no Quest");
      return tree({ ...base, quests: [new Quest({ ...record, state: "completed", endedAt })] });
    };
    for (const each of [top, later]) {
      expect(questTicket(finished(each), published(2, 2))?.progress).toEqual({
        kind: "ended",
        end: "completed",
        took: 17 * 60_000,
      });
      expect(workCard(finished(each))?.took).toBe(17 * 60_000);
    }
    expect(workCard(blackFriday())?.took).toBeNull();
  });

  it("has no ticket for a tree with no Task", () => {
    expect(questTicket(tree({ tasks: [] }), published(0, 0))).toBeNull();
  });
});
