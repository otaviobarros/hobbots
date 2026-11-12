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
  memberApproval,
  QUILL,
  question,
  THREAD,
  task,
  tree,
} from "../../test/quests.ts";
import { BEFORE_ALL, liveTrees, placeMoments, rowStatus, taskDetail, taskTitle, workCard } from "./work-model.ts";

describe("taskTitle", () => {
  it("cuts each folder path in a brief's first line to its last part", () => {
    const title = (brief: string) => taskTitle({ brief });
    expect(title("In /Users/ana/projects/tests/lemon-stand, write check.sh (bash)\nMore")).toBe(
      "In lemon-stand, write check.sh (bash)",
    );
    expect(title("Markup. In /Users/ana/lemon-stand/, create index.html")).toBe(
      "Markup. In lemon-stand, create index.html",
    );
    expect(title("Read ~/notes/plan.md and sum it up.")).toBe("Read plan.md and sum it up.");
    expect(title("Write landing copy for Lemon Stand")).toBe("Write landing copy for Lemon Stand");
    expect(title("Compare a/b with c/d")).toBe("Compare a/b with c/d");
  });
});

const message = (id: string, role: "user" | "assistant", createdAt: string) =>
  ({ id: MessageId.make(id), threadId: THREAD, role, createdAt }) as unknown as Message;

describe("where work stands", () => {
  it("puts a Task that waits on another under waiting, and one a question for you holds under needs you", () => {
    const quest = blackFriday();
    const [, copy, build] = quest.tasks;
    if (copy === undefined || build === undefined) throw new Error("the Black Friday Quest has three Tasks");
    expect([rowStatus(quest, copy), rowStatus(quest, build)]).toEqual(["running", "waiting"]);

    const asking = tree({
      ...quest,
      questions: [question(BUILD, ADA, "Dec 12 for international?", { recipientId: null })],
    });
    expect([rowStatus(asking, copy), rowStatus(asking, build)]).toEqual(["running", "needs-you"]);
  });

  it("puts a member's Task whose turn waits on your approval under needs you", () => {
    const quest = blackFriday();
    const asking = tree({ ...quest, approvals: [memberApproval(COPY, QUILL)] });
    expect(rowStatus(asking, task(COPY, { ownerId: QUILL }))).toBe("needs-you");
    expect(rowStatus(asking, task(CAMPAIGN))).toBe("needs-you");
    expect(taskDetail(asking, task(COPY, { ownerId: QUILL })).approvals.map((each) => each.id)).toEqual(["ap-copy"]);

    // Once you decide it, the Task runs again and nothing needs you.
    const decided = tree({ ...quest, approvals: [memberApproval(COPY, QUILL, { state: "approved", revision: 2 })] });
    expect(rowStatus(decided, task(COPY, { ownerId: QUILL }))).toBe("running");
  });

  it("names who leads a request with no Quest", () => {
    const steps = ["outline", "draft"].map((id, index) => task(TaskId.make(id), { second: index + 1 }));
    const card = workCard(tree({ tasks: [task(CAMPAIGN), ...steps] }));
    expect(card?.quest).toBeNull();
    expect(card?.leadId).toBe(ALDRIC);
  });
});

describe("the strip", () => {
  it("leaves once the work has ended", () => {
    const quest = blackFriday();
    const ended = { ...quest, tasks: [task(CAMPAIGN, { state: "completed" }), ...quest.tasks.slice(1)] };
    expect(liveTrees([quest, ended as typeof quest])).toEqual([quest]);
  });
});

describe("placeMoments", () => {
  it("puts the ticket under the request, not the reply, and a lead's answer after what came before it", () => {
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
    expect(placed.get(MessageId.make("m1"))?.map((moment) => moment.kind)).toEqual(["ticket"]);
    expect(placed.get(MessageId.make("m3"))?.map((moment) => moment.kind)).toEqual(["answered"]);
    expect(placed.has(BEFORE_ALL)).toBe(false);
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
