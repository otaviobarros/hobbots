import { MessageId, NOTE_TEXT_MAX } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { NOTE_OFF, type NoteEvent, type NoteFlow, noteFits, noteStep, writesNote } from "./note-flow.ts";

// Issue #1387 (ADR 037): writing a note to self from the composer, as one reducer (STD-REACT-029).

const K1 = MessageId.make("note-1");
const K2 = MessageId.make("note-2");
const run = (events: ReadonlyArray<NoteEvent>, from: NoteFlow = NOTE_OFF) => events.reduce(noteStep, from);

describe("a note to self", () => {
  it("[TC-CH-1387-25] saves a note only while Note to self is on, trimmed, and turns back to messages once saved", () => {
    expect(run([{ _tag: "Send", key: K1, content: "Hi" }])).toEqual(NOTE_OFF);
    const on = run([{ _tag: "Toggle" }]);
    expect(writesNote(on)).toBe(true);
    expect(run([{ _tag: "Send", key: K1, content: "  " }], on)).toBe(on);
    const saving = run([{ _tag: "Send", key: K1, content: " Ask Ana. " }], on);
    expect(saving).toEqual({ step: "saving", key: K1, content: "Ask Ana." });
    expect(run([{ _tag: "Toggle" }], saving)).toBe(saving);
    const saved = run([{ _tag: "Saved" }], saving);
    expect(saved).toEqual({ step: "saved" });
    expect(writesNote(saved)).toBe(false);
    expect(noteFits("x".repeat(NOTE_TEXT_MAX + 1))).toBe(false);
  });

  it("[TC-CH-1387-26] keeps a failed note's key when the same note is sent again, and a new key for another", () => {
    const failed = run([{ _tag: "Toggle" }, { _tag: "Send", key: K1, content: "Ask Ana." }, { _tag: "Failed" }]);
    expect(failed).toMatchObject({ step: "failed", key: K1 });
    expect(writesNote(failed)).toBe(true);
    expect(run([{ _tag: "Send", key: K2, content: "Ask Ana." }], failed)).toMatchObject({ key: K1 });
    expect(run([{ _tag: "Send", key: K2, content: "Ask Bo." }], failed)).toMatchObject({ key: K2 });
  });
});
