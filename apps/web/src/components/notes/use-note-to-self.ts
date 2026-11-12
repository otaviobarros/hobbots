import type { ThreadId } from "@hobbots/domain";
import { useReducer } from "react";
import { restoreDraft, writeDraft } from "../../api/drafts.ts";
import { useWriteNote } from "../../api/notes.ts";
import type { WaitingPlace } from "../../api/outbox.ts";
import { messages } from "./messages.ts";
import { NOTE_OFF, type NoteEvent, newNoteKey, noteStep, writesNote } from "./note-flow.ts";

/** What the composer needs to write notes to self: whether it writes one now, and how. */
export interface NoteMode {
  readonly on: boolean;
  readonly saving: boolean;
  /** What the last note did, said under the composer, or null. */
  readonly status: string | null;
  readonly onToggle: () => void;
  readonly onNote: (content: string) => void;
}

/**
 * Notes to self from the composer (ADR 037): the draft clears as the note is saved and comes back
 * if it fails. A thread not made yet takes no note.
 */
export const useNoteToSelf = (threadId: ThreadId | undefined, place: WaitingPlace): NoteMode | undefined => {
  const [flow, dispatch] = useReducer(noteStep, NOTE_OFF);
  const write = useWriteNote(threadId ?? ("" as ThreadId));
  if (threadId === undefined) return undefined;
  return {
    on: writesNote(flow),
    saving: flow.step === "saving",
    status: flow.step === "saved" ? messages.saved : flow.step === "failed" ? messages.failed : null,
    onToggle: () => dispatch({ _tag: "Toggle" }),
    onNote: (content) => {
      // The reducer decides whether it saves and under which key; the request follows its answer.
      const event: NoteEvent = { _tag: "Send", key: newNoteKey(), content };
      const next = noteStep(flow, event);
      dispatch(event);
      if (next.step !== "saving") return;
      writeDraft(place, "");
      write.mutate(
        { key: next.key, content: next.content },
        {
          onSuccess: () => dispatch({ _tag: "Saved" }),
          onError: () => {
            dispatch({ _tag: "Failed" });
            restoreDraft(place, content);
          },
        },
      );
    },
  };
};
