import { AgentId, Attempt, AttemptId, Message, MessageId, NoteId, Task, TaskId, TaskNote } from "@hobbots/domain";
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
  THREAD,
  task,
  tree,
} from "../../test/quests.ts";
import { laneNoteChips, runningAt, steerReceiptOf } from "./steer-model.ts";

const at = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, "0")}.000Z`;
const BRAM = AgentId.make("bram");
const RESIZE = TaskId.make("resize");

const message = (
  id: string,
  role: Message["role"],
  second: number,
  fields: Partial<{ promptId: string; status: Message["status"] }> = {},
) =>
  new Message({
    id: MessageId.make(id),
    threadId: THREAD,
    role,
    content: role === "user" ? "Keep the page to three sections" : "On it.",
    status: fields.status ?? "complete",
    error: null,
    configVersion: role === "user" ? null : 1,
    createdAt: at(second),
    promptId: fields.promptId === undefined ? null : MessageId.make(fields.promptId),
  });

const STEER = message("steer", "user", 10);
const reply = (status: Message["status"] = "complete") =>
  message("reply", "assistant", 11, { promptId: "steer", status });

const note = (
  id: string,
  taskId: TaskId,
  recipientId: AgentId,
  fields: Partial<ConstructorParameters<typeof TaskNote>[0]> = {},
) =>
  new TaskNote({
    id: NoteId.make(id),
    taskId,
    recipientId,
    senderId: ALDRIC,
    text: "Keep it to three sections.",
    createdAt: at(12),
    messageId: STEER.id,
    revision: 1,
    ...fields,
  });

const picked = { pickedUpBy: "turn-1", pickedUpAt: at(14) };

const running = (taskId: TaskId, agentId: AgentId) =>
  new Attempt({
    id: AttemptId.make(`a-${taskId}`),
    taskId,
    number: 1,
    agentId,
    runtime: "claude-code",
    sessionId: null,
    configVersion: 1,
    policyVersion: null,
    state: "running",
    outcome: null,
    startedAt: at(3),
    endedAt: null,
  });

const work = (fields: Parameters<typeof tree>[0] = {}) => tree({ ...blackFriday(), ...fields });

describe("the steer receipt under a message of yours", () => {
  it("reads while the lead's turn on it runs, and got it once that turn ends with nothing passed on", () => {
    const trees = [work()];
    expect(steerReceiptOf(STEER, [STEER], trees, ALDRIC)).toEqual({ lead: ALDRIC, read: false, hops: [] });
    expect(steerReceiptOf(STEER, [STEER, reply("streaming")], trees, ALDRIC)?.read).toBe(false);
    expect(steerReceiptOf(STEER, [STEER, reply()], trees, ALDRIC)).toEqual({ lead: ALDRIC, read: true, hops: [] });
  });

  it("names each hob the lead passed it to, and whether it picked it up", () => {
    const trees = [work({ notes: [note("n1", BUILD, ADA, picked), note("n2", COPY, QUILL)] })];
    const receipt = steerReceiptOf(STEER, [STEER, reply("streaming")], trees, ALDRIC);
    expect(receipt?.read).toBe(true);
    expect(receipt?.hops.map(({ hob, state }) => [hob, state])).toEqual([
      [ADA, "picked"],
      [QUILL, "passing"],
    ]);
  });

  it("says a note is held while its hob's turn waits on your approval, with the request", () => {
    const approval = memberApproval(BUILD, ADA);
    const base = work();
    const trees = [
      work({
        tasks: base.tasks.map((each) =>
          each.id === BUILD
            ? new Task({ ...task(BUILD, { ownerId: ADA, second: 3 }), currentAttemptId: AttemptId.make(`a-${BUILD}`) })
            : each,
        ),
        attempts: [running(BUILD, ADA)],
        approvals: [approval],
        notes: [note("n1", BUILD, ADA)],
      }),
    ];
    const [hop] = steerReceiptOf(STEER, [STEER, reply()], trees, ALDRIC)?.hops ?? [];
    expect(hop?.state).toBe("held");
    expect(hop?.approval?.id).toBe(approval.id);
  });

  it("follows a note down through a nested lead", () => {
    const base = work();
    const trees = [
      work({
        tasks: [...base.tasks, task(RESIZE, { ownerId: BRAM, parentId: BUILD, second: 4 })],
        notes: [
          note("n1", BUILD, ADA, picked),
          note("n2", RESIZE, BRAM, { senderId: ADA, fromNoteId: NoteId.make("n1"), createdAt: at(15) }),
        ],
      }),
    ];
    const [toAda] = steerReceiptOf(STEER, [STEER, reply()], trees, ALDRIC)?.hops ?? [];
    expect(toAda?.passedOn.map(({ hob, state }) => [hob, state])).toEqual([[BRAM, "passing"]]);
  });

  it("gives no receipt to a message sent before the work began or after it ended, nor to a reply", () => {
    const before = message("before", "user", 0);
    expect(steerReceiptOf(before, [before], [work()], ALDRIC)).toBeNull();
    const ended = work({ tasks: [task(CAMPAIGN, { state: "completed", second: 0 })] });
    expect(runningAt(ended, at(10))).toBe(false);
    expect(steerReceiptOf(STEER, [STEER, reply()], [ended], ALDRIC)).toBeNull();
    expect(steerReceiptOf(reply(), [STEER, reply()], [work()], ALDRIC)).toBeNull();
  });

  it("gives no receipt to a message with no record of the turn that read it once the work ended", () => {
    const ended = work({ tasks: [new Task({ ...task(CAMPAIGN), state: "completed", updatedAt: at(30) })] });
    expect(runningAt(ended, STEER.createdAt)).toBe(true);
    expect(steerReceiptOf(STEER, [STEER], [ended], ALDRIC)).toBeNull();
  });
});

describe("whether work ran when you sent a message", () => {
  const tryOn = (number: number, state: Attempt["state"], started: number, ended: number | null) =>
    new Attempt({
      id: AttemptId.make(`try-${number}`),
      taskId: CAMPAIGN,
      number,
      agentId: ALDRIC,
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      state,
      outcome: null,
      startedAt: at(started),
      endedAt: ended === null ? null : at(ended),
    });

  it("leaves out a message sent while the work lay failed, even once a retry brings it back", () => {
    // Failed at :05, your message at :06, retried at :10: the Task is active again now.
    const retried = work({
      tasks: [new Task({ ...task(CAMPAIGN), state: "active", updatedAt: at(10) })],
      attempts: [tryOn(1, "failed", 1, 5), tryOn(2, "running", 10, null)],
    });
    expect(runningAt(retried, at(3))).toBe(true);
    expect(runningAt(retried, at(6))).toBe(false);
    expect(runningAt(retried, at(12))).toBe(true);
    const between = message("between", "user", 6);
    expect(steerReceiptOf(between, [between], [retried], ALDRIC)).toBeNull();
    expect(laneNoteChips(retried, [between]).get(ALDRIC)).toBeUndefined();
  });

  it("counts a try that was cut off and resumed as work that kept running", () => {
    const resumed = work({ attempts: [tryOn(1, "interrupted", 1, 5), tryOn(2, "running", 8, null)] });
    expect(runningAt(resumed, at(6))).toBe(true);
  });
});

describe("your notes in the lanes", () => {
  it("shows your message in the lead's lane, whom it passed it to, and the note in each lane it reached", () => {
    const trees = work({ notes: [note("n1", BUILD, ADA, picked), note("n2", COPY, QUILL)] });
    const chips = laneNoteChips(trees, [message("before", "user", 0), STEER, reply()]);
    expect(chips.get(ALDRIC)?.map((chip) => chip._tag)).toEqual(["yours", "passed"]);
    expect(chips.get(ALDRIC)?.[1]).toMatchObject({ to: [ADA, QUILL] });
    expect(chips.get(ADA)).toEqual([expect.objectContaining({ _tag: "via", from: ALDRIC })]);
    expect(chips.get(QUILL)).toEqual([expect.objectContaining({ _tag: "via", from: ALDRIC })]);
  });

  it("shows a nested lead passing your note on, and the note in its member's lane via that lead", () => {
    const base = work();
    const trees = work({
      tasks: [...base.tasks, task(RESIZE, { ownerId: BRAM, parentId: BUILD, second: 4 })],
      notes: [
        note("n1", BUILD, ADA, picked),
        note("n2", RESIZE, BRAM, { senderId: ADA, fromNoteId: NoteId.make("n1"), createdAt: at(15) }),
      ],
    });
    const chips = laneNoteChips(trees, [STEER]);
    expect(chips.get(ADA)?.map((chip) => chip._tag)).toEqual(["via", "passed"]);
    expect(chips.get(BRAM)).toEqual([expect.objectContaining({ _tag: "via", from: ADA })]);
  });
});
