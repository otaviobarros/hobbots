import { Task, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  memberApproval,
  QUILL,
  question,
  task,
  tree,
} from "../../test/quests.ts";
import { messages } from "./messages.ts";
import { questTicket } from "./ticket-model.ts";

/** The Black Friday Quest with its Tasks changed: each entry replaces the Task with that id. */
const withTasks = (...tasks: ReadonlyArray<Task>) => {
  const quest = blackFriday();
  return tree({ ...quest, tasks: quest.tasks.map((each) => tasks.find((next) => next.id === each.id) ?? each) });
};

/** A Task that ended `minutes` after it started. */
const ended = (base: Task, state: Task["state"], minutes: number) =>
  new Task({ ...base, state, updatedAt: new Date(Date.parse(base.createdAt) + minutes * 60_000).toISOString() });

describe("questTicket", () => {
  it("shows the party in lane order, with how many Tasks are done", () => {
    const ticket = questTicket(withTasks(task(COPY, { ownerId: QUILL, state: "completed", second: 2 })));
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

  it("counts a question, an approval and a failed Task as what needs you", () => {
    const quest = blackFriday();
    const asking = tree({
      ...quest,
      questions: [question(BUILD, ADA, "Dec 12 for international?", { recipientId: null })],
      approvals: [memberApproval(COPY, QUILL)],
    });
    expect(questTicket(asking)?.needsYou).toBe(2);
    expect(messages.needsYou(2)).toBe("2 need you");

    const failed = withTasks(task(COPY, { ownerId: QUILL, state: "failed", second: 2 }));
    expect(questTicket(failed)?.needsYou).toBe(1);
    expect(questTicket(failed)?.party.find((member) => member.hobId === QUILL)?.status).toBe("failed");
    expect(messages.needsYou(1)).toBe("1 needs you");
  });

  it("says when a Task working alone started", () => {
    const solo = questTicket(tree({ tasks: [task(CAMPAIGN, { brief: "Tidy the notes" })] }));
    expect(solo?.party.map((member) => member.hobId)).toEqual([ALDRIC]);
    expect(solo?.progress).toEqual({ kind: "started", at: task(CAMPAIGN).createdAt });
  });

  it("keeps one sprite per hob when a hob has steps or more than one Task", () => {
    const steps = ["outline", "draft"].map((id, index) => task(TaskId.make(id), { second: index + 1 }));
    const ticket = questTicket(tree({ tasks: [task(CAMPAIGN), ...steps] }));
    expect(ticket?.party.map((member) => member.hobId)).toEqual([ALDRIC]);
    expect(ticket?.progress).toEqual({ kind: "count", done: 0, total: 2 });
  });

  it("says how the work ended and how long it ran, and asks nothing more of you", () => {
    const top = task(CAMPAIGN, { brief: "Plan a Black Friday campaign" });
    const done = questTicket(withTasks(ended(top, "completed", 18)));
    expect(done?.progress).toEqual({ kind: "ended", end: "completed", took: 18 * 60_000 });
    expect(messages.progress(done?.progress ?? { kind: "count", done: 0, total: 0 })).toBe("Finished in 18 min");

    const failed = questTicket(withTasks(ended(top, "failed", 4), task(COPY, { ownerId: QUILL, state: "failed" })));
    expect(failed?.needsYou).toBe(0);
    expect(messages.progress(failed?.progress ?? { kind: "count", done: 0, total: 0 })).toBe("Failed after 4 min");

    const cancelled = questTicket(withTasks(ended(top, "cancelled", 2)));
    expect(messages.progress(cancelled?.progress ?? { kind: "count", done: 0, total: 0 })).toBe(
      "Cancelled after 2 min",
    );
  });

  it("has no ticket for a tree with no Task", () => {
    expect(questTicket(tree({ tasks: [] }))).toBeNull();
  });
});
