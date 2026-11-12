import { MessageId, NOTE_TEXT_MAX } from "@hobbots/domain";

// Writing a note to self from the composer (ADR 037) as one reducer over a union of its steps
// (STD-REACT-029): Note to self turns the composer to notes, the note is saved under a key, and a
// failure gives its text back. A saved note says so and turns the composer back to messages.

export type NoteFlow =
  | { readonly step: "off" }
  | { readonly step: "on" }
  | { readonly step: "saving"; readonly key: MessageId; readonly content: string }
  | { readonly step: "saved" }
  | { readonly step: "failed"; readonly key: MessageId; readonly content: string };

export type NoteEvent =
  | { readonly _tag: "Toggle" }
  /** `key` is a new key, used unless a failed note is sent again unchanged. */
  | { readonly _tag: "Send"; readonly key: MessageId; readonly content: string }
  | { readonly _tag: "Saved" }
  | { readonly _tag: "Failed" };

export const NOTE_OFF: NoteFlow = { step: "off" };

/** Whether the composer writes a note now. */
export const writesNote = (flow: NoteFlow): boolean =>
  flow.step === "on" || flow.step === "saving" || flow.step === "failed";

/** Whether `content` fits a note, as the hub reads it: trimmed. */
export const noteFits = (content: string): boolean => {
  const trimmed = content.trim();
  return trimmed.length > 0 && trimmed.length <= NOTE_TEXT_MAX;
};

export const noteStep = (flow: NoteFlow, event: NoteEvent): NoteFlow => {
  switch (event._tag) {
    case "Toggle":
      if (flow.step === "saving") return flow;
      return writesNote(flow) ? NOTE_OFF : { step: "on" };
    case "Send": {
      if (!writesNote(flow) || flow.step === "saving" || !noteFits(event.content)) return flow;
      // The same note again after a failure keeps its key, so one saved before its answer was lost
      // is written once.
      const content = event.content.trim();
      const key = flow.step === "failed" && flow.content === content ? flow.key : event.key;
      return { step: "saving", key, content };
    }
    case "Saved":
      return flow.step === "saving" ? { step: "saved" } : flow;
    case "Failed":
      return flow.step === "saving" ? { ...flow, step: "failed" } : flow;
  }
};

/** A new key for a note, which becomes its id. */
export const newNoteKey = (): MessageId => MessageId.make(`note-${crypto.randomUUID()}`);
