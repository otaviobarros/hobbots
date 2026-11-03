import { NoteId, TaskNote } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, BUILD, blackFriday } from "../../test/quests.ts";
import { taskDetail } from "./work-model.ts";

// Issue #574: a lead's message to its member's Task is kept as a note the lead sent. The drawer's
// "Your notes" lists only the notes you left.

const note = (id: string, text: string, senderId: typeof ALDRIC | null) =>
  new TaskNote({
    id: NoteId.make(id),
    taskId: BUILD,
    recipientId: senderId === null ? ALDRIC : ADA,
    senderId,
    text,
    createdAt: "2026-11-03T00:00:00.000Z",
    revision: 9,
  });

describe("a lead's message on a member's Task", () => {
  it("never shows among your notes on that Task", () => {
    const quest = blackFriday();
    const withNotes = {
      ...quest,
      notes: [note("yours", "Use the dark theme", null), note("lead", "git init is done; go on", ALDRIC)],
    } as typeof quest;
    const build = withNotes.tasks.find((each) => each.id === BUILD);
    if (build === undefined) throw new Error("no build Task");
    expect(taskDetail(withNotes, build).notes.map((each) => each.text)).toEqual(["Use the dark theme"]);
  });
});
