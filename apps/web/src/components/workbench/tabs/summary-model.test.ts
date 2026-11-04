import {
  ApprovalId,
  ApprovalRequest,
  ArtifactId,
  ArtifactRef,
  Attempt,
  AttemptActivity,
  AttemptId,
  Checkpoint,
  FileChange,
  FileChangeId,
  MessageId,
  Question,
  QuestionId,
  Task,
  type TaskId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  checkpoint,
  milestone,
  question,
  THREAD,
  task,
  tree,
} from "../../../test/quests.ts";
import { changePath, markOf, summaryOf } from "./summary-model.ts";

const AT = "2026-11-01T10:00:00.000Z";
const done = attempt(CAMPAIGN, "completed");

const tryOf = (taskId: TaskId, number: number, state: Attempt["state"] = "completed") =>
  new Attempt({ ...attempt(taskId, state), id: AttemptId.make(`a-${taskId}-${number}`), number });

const change = (path: string, kind: FileChange["kind"] = "edited", settled = true) =>
  new FileChange({
    id: FileChangeId.make(`f-${path}-${settled}`),
    attemptId: done.id,
    taskId: CAMPAIGN,
    folder: "/work",
    path,
    kind,
    movedFrom: null,
    before: kind === "added" ? null : { hash: "a", size: 3, kind: "text", contentId: null, notKept: null },
    after: kind === "deleted" ? null : { hash: "b", size: 3, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled,
    recordedAt: AT,
  });

const activity = (changes: ReadonlyArray<FileChange>) =>
  new AttemptActivity({
    attempt: done,
    commands: [],
    changes,
    scans: [],
    artifacts: [],
    sharedWithHobs: [],
    detailsClearedAt: null,
  });

const artifact = (kind: ArtifactRef["kind"], value: string, attemptId: AttemptId = done.id) =>
  new ArtifactRef({
    id: ArtifactId.make(`r-${value}`),
    taskId: CAMPAIGN,
    attemptId,
    kind,
    label: value,
    value,
    createdAt: AT,
  });

const approval = (fields: Partial<Pick<ApprovalRequest, "taskId" | "rootTaskId" | "state">>) =>
  new ApprovalRequest({
    id: ApprovalId.make(`ap-${fields.taskId ?? "chat"}-${fields.state ?? "pending"}`),
    agentId: ALDRIC,
    threadId: THREAD,
    messageId: MessageId.make("m1"),
    taskId: fields.taskId ?? null,
    rootTaskId: fields.rootTaskId ?? CAMPAIGN,
    stepId: "s1",
    tool: "Bash",
    operation: "run-commands",
    targets: [],
    arguments: {},
    label: "Running git push",
    reason: "Pushing needs you",
    actionDigest: "d",
    policyVersion: "p",
    state: fields.state ?? "pending",
    denyReason: null,
    createdAt: AT,
    decidedAt: null,
    revision: 1,
  });

describe("summaryOf", () => {
  it("names what the Task made: its references in the chosen Attempt and each changed file once, by path", () => {
    const records = tree({
      tasks: [task(CAMPAIGN, { state: "completed" })],
      attempts: [done],
      artifacts: [
        artifact("file", "/work/report.md"),
        artifact("link", "https://example.com"),
        artifact("text", "older", AttemptId.make("a-earlier")),
      ],
    });
    const summary = summaryOf(
      records,
      records.tasks[0] ?? task(CAMPAIGN),
      done,
      activity([change("b.md", "edited", false), change("a.md", "added"), change("b.md")]),
      [],
    );
    expect(summary.made.artifacts.map((each) => each.value)).toEqual(["/work/report.md", "https://example.com"]);
    expect(summary.made.changes.map((each) => [each.path, each.change.settled])).toEqual([
      ["/work/a.md", true],
      ["/work/b.md", true],
    ]);
    expect(summary.used).toEqual({ changes: 2, files: 3, commands: 0 });
  });

  it("counts a file it made and changed as one file, and a deleted file as none", () => {
    const records = tree({ attempts: [done], artifacts: [artifact("file", "/work/a.md")] });
    const summary = summaryOf(
      records,
      task(CAMPAIGN),
      done,
      activity([change("a.md"), change("gone.md", "deleted")]),
      [],
    );
    expect(summary.used.files).toBe(1);
    expect(changePath(change("a.md"))).toBe("/work/a.md");
  });

  it("lists steps in order with their marks and tries, and members' Tasks by owner", () => {
    const one = task("s1" as TaskId, { state: "completed", second: 5 });
    const two = task("s2" as TaskId, { state: "failed", second: 5 });
    const three = task("s3" as TaskId, { state: "queued", second: 5 });
    const member = task(BUILD, { ownerId: ADA, state: "waiting", second: 9 });
    const records = tree({
      tasks: [task(CAMPAIGN), one, two, three, member],
      attempts: [tryOf(one.id, 1), tryOf(two.id, 1, "failed"), tryOf(two.id, 2, "failed")],
    });
    const lines = summaryOf(records, records.tasks[0] ?? task(CAMPAIGN), null, null, []).happened;
    expect(
      lines.map((line) =>
        line.kind === "step"
          ? [line.index, line.total, line.mark, line.tries]
          : line.kind === "member"
            ? [line.task.ownerId, line.mark]
            : line.kind,
      ),
    ).toEqual([
      [1, 3, "done", 1],
      [2, 3, "failed", 2],
      [3, 3, "next", 0],
      [ADA, "waiting"],
    ]);
  });

  it("keeps what the owner reported in the chosen Attempt, a milestone once, and the ones still ahead last", () => {
    const reached = milestone(CAMPAIGN, "Copy drafted", 0, true);
    const ahead = milestone(CAMPAIGN, "Page live", 1);
    const reachedReport = checkpoint(CAMPAIGN, "milestone", "Copy drafted", 6);
    const records = tree({
      milestones: [ahead, reached],
      checkpoints: [
        checkpoint(CAMPAIGN, "started", "", 1),
        checkpoint(CAMPAIGN, "finding", "Prices change Friday", 4),
        new Checkpoint({ ...reachedReport, milestoneId: reached.id }),
        new Checkpoint({
          ...checkpoint(CAMPAIGN, "progress", "From another attempt", 7),
          attemptId: AttemptId.make("a-other"),
        }),
        checkpoint(CAMPAIGN, "blocker", "No access to the shop", 8),
      ],
    });
    const lines = summaryOf(records, task(CAMPAIGN), done, null, []).happened;
    expect(lines.map((line) => [line.kind, line.mark])).toEqual([
      ["checkpoint", "done"],
      ["milestone", "done"],
      ["checkpoint", "waiting"],
      ["milestone", "next"],
    ]);
  });

  it("says when the chosen Attempt ended without finishing", () => {
    const failed = new Attempt({ ...attempt(CAMPAIGN, "failed"), outcome: "The runtime stopped answering." });
    const lines = summaryOf(
      tree({ attempts: [failed] }),
      task(CAMPAIGN, { state: "failed" }),
      failed,
      null,
      [],
    ).happened;
    expect(lines).toEqual([{ kind: "ended", attempt: failed, mark: "failed" }]);
  });

  it("never calls a stop it could not confirm stopped", () => {
    const unresolved = attempt(CAMPAIGN, "unresolved");
    const cancelled = attempt(CAMPAIGN, "cancelled");
    const ended = (each: Attempt) =>
      summaryOf(tree({ attempts: [each] }), task(CAMPAIGN), each, null, []).happened.map((line) => line.mark);
    expect(ended(unresolved)).toEqual(["unresolved"]);
    expect(ended(cancelled)).toEqual(["cancelled"]);
  });

  it("keeps open questions under the Task and approvals pending in its work", () => {
    const records = blackFriday();
    const campaign = records.tasks[0] ?? task(CAMPAIGN);
    const withQuestions = tree({
      ...records,
      questions: [
        question(COPY, ADA, "Which tone?", { recipientId: null }),
        new Question({ ...question(BUILD, ADA, "Done already", { state: "answered" }), id: QuestionId.make("q-done") }),
      ],
    });
    const summary = summaryOf(withQuestions, campaign, null, null, [
      approval({}),
      approval({ taskId: BUILD }),
      approval({ taskId: BUILD, state: "approved" }),
      approval({ rootTaskId: "elsewhere" as TaskId }),
    ]);
    expect(summary.open.questions.map((each) => each.text)).toEqual(["Which tone?"]);
    expect(summary.open.approvals.map((each) => each.taskId)).toEqual([null, BUILD]);

    // The question the task chat holds for you shows there, not again under Still open.
    const asked = tree({
      ...withQuestions,
      questions: [question(CAMPAIGN, ALDRIC, "Short headings?", { recipientId: null })],
    });
    const withAsk = summaryOf(asked, campaign, null, null, []);
    expect(withAsk.open.questions).toEqual([]);
    expect(withAsk.line).toEqual({ kind: "asks", asker: ALDRIC, earlier: 0 });

    // A member's own Summary keeps only what is under it.
    const build = withQuestions.tasks.find((each) => each.id === BUILD) ?? task(BUILD);
    const member = summaryOf(withQuestions, build, null, null, [approval({}), approval({ taskId: BUILD })]);
    expect(member.open.questions).toEqual([]);
    expect(member.open.approvals.map((each) => each.taskId)).toEqual([BUILD]);
    expect(member.asked).toEqual({ brief: "Build the campaign", from: ALDRIC, expected: null });
  });
});

describe("summaryOf's line", () => {
  const lineOf = (state: Task["state"], tries: ReadonlyArray<Attempt>, shown: Attempt | null, result = false) => {
    const own = new Task({
      ...task(CAMPAIGN, { state }),
      result: result ? { summary: "Tidied.", attemptId: tries[0]?.id ?? done.id } : null,
    });
    return summaryOf(tree({ tasks: [own], attempts: [...tries] }), own, shown, null, []).line;
  };

  it("leads with the result, saying which Attempt it came from when another is shown", () => {
    const first = tryOf(CAMPAIGN, 1);
    const second = tryOf(CAMPAIGN, 2, "failed");
    expect(lineOf("completed", [first, second], first, true)).toEqual({
      kind: "result",
      summary: "Tidied.",
      from: null,
      earlier: 0,
    });
    expect(lineOf("completed", [first, second], second, true)).toMatchObject({ kind: "result", from: 1 });
  });

  it("says where the Attempt shown stands while there is no result, counting the tries before it that ended early", () => {
    const failed = tryOf(CAMPAIGN, 1, "failed");
    const running = tryOf(CAMPAIGN, 2, "running");
    expect(lineOf("queued", [], null)).toEqual({ kind: "not-started", earlier: 0 });
    expect(lineOf("active", [failed, running], running)).toEqual({ kind: "working", attempt: 2, earlier: 1 });
    expect(lineOf("waiting", [failed, running], running)).toEqual({ kind: "waiting", attempt: 2, earlier: 1 });
    expect(lineOf("failed", [failed], failed)).toEqual({ kind: "ended", attempt: 1, mark: "failed", earlier: 0 });
    expect(lineOf("cancelled", [], null)).toEqual({ kind: "no-result", earlier: 0 });
  });
});

describe("markOf", () => {
  it("reads a Task's state as a mark", () => {
    expect(
      (["queued", "active", "waiting", "blocked", "cancelling", "completed", "failed", "cancelled"] as const).map(
        markOf,
      ),
    ).toEqual(["next", "running", "waiting", "waiting", "running", "done", "failed", "cancelled"]);
  });
});
