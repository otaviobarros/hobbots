import { type Message, MessageId, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  checkpoint,
  delegation,
  QUILL,
  question,
  THREAD,
  task,
  tree,
} from "../../test/quests.ts";
import { BEFORE_ALL, liveTrees, noteRecipient, placeMoments, taskDetail, workCard, workCounts } from "./work-model.ts";

const message = (id: string, role: "user" | "assistant", createdAt: string) =>
  ({ id: MessageId.make(id), threadId: THREAD, role, createdAt }) as unknown as Message;

describe("workCard", () => {
  it("shows the party and orders rows by what needs you, then running, then waiting", () => {
    const quest = blackFriday();
    const card = workCard(quest);
    expect(card?.party).toEqual([QUILL, ADA]);
    expect(card?.rows.map((row) => [row.task.id, row.status, row.waitsOn])).toEqual([
      [COPY, "running", []],
      [BUILD, "waiting", [QUILL]],
    ]);

    const asking = { ...quest, questions: [question(BUILD, ADA, "Dec 12 for international?", { recipientId: null })] };
    expect(workCard(asking as typeof quest)?.rows.map((row) => [row.task.id, row.status])).toEqual([
      [BUILD, "needs-you"],
      [COPY, "running"],
    ]);
  });

  it("shows only the current step of a Task with steps, as step 3 of 4", () => {
    const steps = ["outline", "draft", "edit", "publish"].map((id, index) =>
      task(TaskId.make(id), { state: index < 2 ? "completed" : "queued", second: index + 1 }),
    );
    const card = workCard(tree({ tasks: [task(CAMPAIGN), ...steps] }));
    expect(card?.rows.map((row) => [row.task.id, row.step])).toEqual([["edit", { index: 3, total: 4 }]]);
    expect(card?.progress).toEqual({ done: 2, total: 4 });
    expect(card?.party).toEqual([]);
  });

  it("keeps a failed step in view instead of folding it into done or skipping past it", () => {
    const only = workCard(
      tree({ tasks: [task(CAMPAIGN), task(TaskId.make("draft"), { state: "failed", second: 1 })] }),
    );
    expect(only?.rows.map((row) => [row.task.id, row.status])).toEqual([["draft", "failed"]]);
    expect(only?.done).toBe(0);

    const steps = [
      task(TaskId.make("outline"), { state: "failed", second: 1 }),
      task(TaskId.make("draft"), { state: "queued", second: 2 }),
    ];
    const card = workCard(tree({ tasks: [task(CAMPAIGN), ...steps] }));
    expect(card?.rows.map((row) => [row.task.id, row.status, row.step])).toEqual([
      ["outline", "failed", { index: 1, total: 2 }],
    ]);
  });

  it("folds done rows into a count and keeps at most four", () => {
    const members = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      task(TaskId.make(id), { ownerId: QUILL, state: index === 0 ? "completed" : "active", second: index + 1 }),
    );
    const card = workCard(
      tree({
        tasks: [task(CAMPAIGN), ...members],
        delegations: members.map((member) => delegation(QUILL, member.id, member.brief)),
      }),
    );
    expect(card?.rows.map((row) => row.task.id)).toEqual(["b", "c", "d", "e"]);
    expect(card?.more).toBe(1);
    expect(card?.done).toBe(1);
  });
});

describe("the strip", () => {
  it("counts the work under the request and leaves once it has ended", () => {
    const quest = blackFriday();
    expect(workCounts(quest)).toMatchObject({ running: 1, waiting: 1, "needs-you": 0 });
    const ended = { ...quest, tasks: [task(CAMPAIGN, { state: "completed" }), ...quest.tasks.slice(1)] };
    expect(liveTrees([quest, ended as typeof quest])).toEqual([quest]);
  });
});

describe("placeMoments", () => {
  it("puts the card under the request, not the reply, and a lead's answer after what came before it", () => {
    const quest = {
      ...blackFriday(),
      questions: [
        question(COPY, QUILL, "Which discount?", {
          state: "answered",
          answer: "20%",
          answeredBy: { _tag: "Lead", agentId: ALDRIC },
        }),
      ],
    } as ReturnType<typeof blackFriday>;
    const transcript = [
      message("m1", "user", "2026-11-01T09:59:59.000Z"),
      message("m2", "assistant", "2026-11-01T09:59:59.500Z"),
      message("m3", "assistant", "2026-11-01T10:00:24.000Z"),
    ];
    const placed = placeMoments(transcript, [quest]);
    expect(placed.get(MessageId.make("m1"))?.map((moment) => moment.kind)).toEqual(["card"]);
    expect(placed.get(MessageId.make("m3"))?.map((moment) => moment.kind)).toEqual(["answered"]);
    expect(placed.has(BEFORE_ALL)).toBe(false);
  });
});

describe("noteRecipient", () => {
  it("sends a note on a member's Task to its lead, and one on the Task you asked for to its owner", () => {
    const quest = blackFriday();
    const [campaign, copy] = quest.tasks;
    if (campaign === undefined || copy === undefined) throw new Error("no Tasks");
    expect(noteRecipient(quest, copy)).toBe(ALDRIC);
    expect(noteRecipient(quest, campaign)).toBe(ALDRIC);
    // Quill's own step still goes to Aldric, the nearest hob above that is not Quill.
    const step = task(TaskId.make("outline"), { ownerId: QUILL, parentId: COPY });
    expect(noteRecipient({ ...quest, tasks: [...quest.tasks, step] } as typeof quest, step)).toBe(ALDRIC);
  });
});

describe("taskDetail", () => {
  it("shows the brief its lead gave, its checkpoints and what was handed to it", () => {
    const quest = blackFriday();
    const withWork = {
      ...quest,
      checkpoints: [checkpoint(BUILD, "progress", "Keyword research done", 7)],
    } as typeof quest;
    const build = withWork.tasks.find((each) => each.id === BUILD);
    if (build === undefined) throw new Error("no build Task");
    const detail = taskDetail(withWork, build);
    expect(detail).toMatchObject({ brief: "Build the campaign", from: ALDRIC, status: "waiting" });
    expect(detail.checkpoints.map((each) => each.summary)).toEqual(["Keyword research done"]);
    expect(taskDetail(quest, quest.tasks[0] ?? build).rows.map((row) => row.task.id)).toEqual([COPY, BUILD]);
  });
});
