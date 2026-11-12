import { AttemptId, Message, MessageId, NoteId, Task, TaskNote } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, BUILD, blackFriday, CAMPAIGN, COPY, QUILL, THREAD, tree } from "../../test/quests.ts";
import { questThread } from "./quest-thread.ts";

// #1390: a quest opens as a thread in its camp's sheet. The thread is built from records: your
// messages while it ran, the lead's replies, the notes it gave its party and what each member did.

const at = (second: number) =>
  `2026-11-01T10:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;

const message = (
  id: string,
  role: Message["role"],
  second: number,
  fields: Partial<{ promptId: string; quiet: boolean; status: Message["status"]; content: string }> = {},
) =>
  new Message({
    id: MessageId.make(id),
    threadId: THREAD,
    role,
    content: fields.content ?? `${role} ${id}`,
    status: fields.status ?? "complete",
    error: null,
    configVersion: role === "user" ? null : 1,
    createdAt: at(second),
    promptId: fields.promptId === undefined ? null : MessageId.make(fields.promptId),
    quiet: fields.quiet ?? false,
  });

const quest = (fields: Parameters<typeof tree>[0] = {}) => tree({ ...blackFriday(), ...fields });

const kinds = (entries: ReturnType<typeof questThread>) =>
  entries.map((entry) =>
    entry.kind === "yours" || entry.kind === "lead"
      ? `${entry.kind}:${entry.message.id}`
      : `${entry.kind}:${entry.key}`,
  );

describe("a quest's thread in the sheet", () => {
  it("[TC-UX-1390-04] starts at your request and the lead's plan, and keeps what you and the lead said while it ran", () => {
    const transcript = [
      message("earlier", "user", 0),
      message("earlier-reply", "assistant", 0, { promptId: "earlier" }),
      message("ask", "user", 0),
      message("plan", "assistant", 0, { promptId: "ask" }),
      message("steer", "user", 10),
      message("answer", "assistant", 11, { promptId: "steer" }),
    ];
    expect(kinds(questThread(quest(), transcript))).toEqual(["yours:ask", "lead:plan", "yours:steer", "lead:answer"]);
  });

  it("[TC-UX-1390-05] leaves out the lead's routine progress, kept quiet, as the chat does", () => {
    const transcript = [message("ask", "user", 0), message("progress", "assistant", 20, { quiet: true })];
    expect(kinds(questThread(quest(), transcript))).toEqual(["yours:ask"]);
  });

  it("[TC-UX-1390-06] shows the notes a lead gave its party, and what each member delivered or where it failed", () => {
    const base = blackFriday();
    const done = (task: Task, second: number, summary: string) =>
      new Task({
        ...task,
        state: "completed",
        result: { summary, attemptId: AttemptId.make(`a-${task.id}`) },
        updatedAt: at(second),
      });
    const [campaign, copy, build] = base.tasks as [Task, Task, Task];
    const work = quest({
      tasks: [
        campaign,
        done(copy, 30, "Three headlines, in docs/copy.md"),
        new Task({ ...build, state: "failed", updatedAt: at(40) }),
      ],
      notes: [
        new TaskNote({
          id: NoteId.make("lead-note"),
          taskId: BUILD,
          recipientId: ADA,
          senderId: ALDRIC,
          text: "Use the copy in docs/copy.md.",
          createdAt: at(31),
          revision: 1,
        }),
        // A note you left on a Task is yours, and shows as your message's receipt instead.
        new TaskNote({
          id: NoteId.make("your-note"),
          taskId: COPY,
          recipientId: QUILL,
          senderId: null,
          text: "Shorter, please.",
          createdAt: at(5),
          revision: 1,
        }),
      ],
    });
    const entries = questThread(work, []);
    expect(kinds(entries)).toEqual([`done:done-${COPY}`, "note:lead-note", `failed:failed-${BUILD}`]);
    expect(entries[0]).toMatchObject({ text: "Three headlines, in docs/copy.md" });
    expect(entries[1]).toMatchObject({ from: ALDRIC, to: ADA });
    // The top Task's own end is the finish banner's, not the thread's.
    expect(
      questThread(quest({ tasks: [new Task({ ...campaign, state: "completed", updatedAt: at(50) })] }), []),
    ).toEqual([]);
  });

  it("[TC-UX-1390-07] keeps the lead's finish, written as the quest ends, and nothing it says after", () => {
    const [campaign, ...rest] = blackFriday().tasks as [Task, ...Task[]];
    const ended = quest({ tasks: [new Task({ ...campaign, state: "completed", updatedAt: at(50) }), ...rest] });
    const transcript = [
      message("ask", "user", 0),
      message("finish", "assistant", 51),
      message("later", "user", 300),
      message("later-reply", "assistant", 301, { promptId: "later" }),
    ];
    expect(kinds(questThread(ended, transcript))).toEqual(["yours:ask", "lead:finish"]);
    expect(questThread(tree({ tasks: [] }), transcript)).toEqual([]);
    expect(CAMPAIGN).toBe(campaign.id);
  });
});
