import { NoteId, type Task, type TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { ApiError } from "../../api/client.ts";
import { useLeaveNote } from "../../api/questions.ts";
import { enterSends } from "./enter-sends.ts";
import { messages } from "./messages.ts";
import type { HobLookup } from "./use-work.ts";
import { noteRecipient } from "./work-model.ts";

const copy = messages.drawer;

/**
 * An unsent note and the key it goes out under. The key changes with the text, so the same note
 * sent again, even after the drawer closed, is left once; a different note is a new one.
 */
export interface NoteDraft {
  readonly text: string;
  readonly key: NoteId;
}

export const emptyNote = (): NoteDraft => ({ text: "", key: NoteId.make(crypto.randomUUID()) });

/** The box under a Task's details where you leave a note for its lead (ADR 018). */
export function NoteBox({
  tree,
  task,
  hobs,
  draft,
  setDraft,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  draft: NoteDraft;
  setDraft: (draft: NoteDraft) => void;
}) {
  const lead = hobs(noteRecipient(tree, task));
  const send = useLeaveNote(task.id);
  const text = draft.text.trim();
  const submit = () => {
    if (text === "" || send.isPending) return;
    send.mutate({ key: draft.key, text }, { onSuccess: () => setDraft(emptyNote()) });
  };
  const ended =
    send.error instanceof ApiError && send.error.tag === "NoteRefused" && send.error.fields.reason === "task-ended";
  return (
    <form
      className="flex flex-col gap-1.5 border-t-2 border-line px-3.5 pt-2.5 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span className="flex gap-2">
        <Textarea
          aria-label={copy.noteLabel({ name: lead.name })}
          placeholder={copy.noteLabel({ name: lead.name })}
          value={draft.text}
          onChange={(event) => setDraft({ ...emptyNote(), text: event.target.value })}
          onKeyDown={enterSends(submit)}
          className="min-h-9 flex-1 rounded-none border-2 border-control bg-deep text-sm text-text"
        />
        <Button type="submit" size="sm" disabled={text === "" || send.isPending}>
          {copy.send}
        </Button>
      </span>
      <span role="status" className="text-xs text-label">
        {send.isError
          ? ended
            ? copy.noteRefused({ name: lead.name })
            : copy.noteFailed
          : send.isSuccess && draft.text === ""
            ? copy.sent({ name: lead.name })
            : copy.noteHint({ name: lead.name })}
      </span>
    </form>
  );
}
