import { describe, expect, it } from "vitest";
import {
  AgentId,
  Attempt,
  AttemptId,
  MessageId,
  NoteId,
  noteReceipt,
  steerReceipt,
  Task,
  TaskId,
  TaskNote,
  type TaskState,
  TaskTree,
} from "../src/index.ts";

const at = "2026-11-04T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const ADA = AgentId.make("ada");
const ASKED = MessageId.make("asked");

const task = (id: string, owner: AgentId, parent: string | null, state: TaskState = "active", attempt?: string) =>
  new Task({
    id: TaskId.make(id),
    ownerId: owner,
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: TaskId.make("top"),
    threadId: null,
    brief: id,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: attempt === undefined ? null : AttemptId.make(attempt),
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const running = (id: string, taskId: string) =>
  new Attempt({
    id: AttemptId.make(id),
    taskId: TaskId.make(taskId),
    number: 1,
    agentId: ADA,
    runtime: "claude-code",
    sessionId: null,
    configVersion: 1,
    policyVersion: null,
    state: "running",
    outcome: null,
    startedAt: at,
    endedAt: null,
  });

const note = (id: string, fields: Partial<ConstructorParameters<typeof TaskNote>[0]> = {}) =>
  new TaskNote({
    id: NoteId.make(id),
    taskId: TaskId.make("ada"),
    recipientId: ADA,
    senderId: ALDRIC,
    text: "Use the blue theme.",
    createdAt: at,
    messageId: ASKED,
    revision: 1,
    ...fields,
  });

const tree = (tasks: ReadonlyArray<Task>, records: Partial<ConstructorParameters<typeof TaskTree>[0]> = {}) =>
  new TaskTree({
    tasks,
    quests: [],
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints: [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
    ...records,
  });

const top = task("top", ALDRIC, null);

describe("noteReceipt", () => {
  it("is sent while its recipient is idle, held while its turn runs, and unread once its work ended", () => {
    expect(noteReceipt(note("n"), tree([top, task("ada", ADA, "top", "blocked")]))).toEqual({ _tag: "Sent" });
    const busy = tree([top, task("ada", ADA, "top", "active", "a1")], { attempts: [running("a1", "ada")] });
    expect(noteReceipt(note("n"), busy)).toEqual({ _tag: "Held", reason: "turn-running" });
    expect(noteReceipt(note("n"), tree([top, task("ada", ADA, "top", "cancelled")]))).toEqual({ _tag: "Unread" });
  });

  it("is picked up once a turn did, even while that turn still runs", () => {
    const busy = tree([top, task("ada", ADA, "top", "active", "a1")], { attempts: [running("a1", "ada")] });
    expect(noteReceipt(note("n", { pickedUpBy: "a1", pickedUpAt: at }), busy)).toEqual({
      _tag: "PickedUp",
      turnId: "a1",
      at,
    });
  });
});

describe("steerReceipt", () => {
  it("lists only the notes that trace back to the message, each with the notes passed on from it", () => {
    const tasks = [top, task("ada", ADA, "top", "waiting"), task("bob", AgentId.make("bob"), "ada", "blocked")];
    const notes = [
      note("to-ada"),
      note("to-bob", {
        taskId: TaskId.make("bob"),
        senderId: ADA,
        recipientId: AgentId.make("bob"),
        fromNoteId: NoteId.make("to-ada"),
      }),
      note("other", { messageId: MessageId.make("another") }),
      note("yours", { senderId: null, messageId: null }),
    ];
    const receipt = steerReceipt([tree(tasks, { notes })], ASKED);
    expect(receipt.map((each) => each.note.id)).toEqual(["to-ada"]);
    expect(receipt[0]?.passedOn.map((each) => [each.note.id, each.receipt._tag])).toEqual([["to-bob", "Sent"]]);
    expect(steerReceipt([tree(tasks, { notes })], MessageId.make("unanswered"))).toEqual([]);
  });

  it("stops at a note that names itself as where it came from", () => {
    const looped = note("loop", { fromNoteId: NoteId.make("loop") });
    expect(steerReceipt([tree([top, task("ada", ADA, "top")], { notes: [looped] })], ASKED)).toEqual([]);
  });
});
