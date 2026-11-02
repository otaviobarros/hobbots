import { NoteId, type Task, type TaskId, type TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { useState } from "react";
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

const emptyNote = (): NoteDraft => ({ text: "", key: NoteId.make(crypto.randomUUID()) });

/** Each Task's unsent note, shared by the drawer and the Workbench so both show the same one. */
export interface NoteDrafts {
  readonly get: (taskId: TaskId) => NoteDraft;
  readonly set: (taskId: TaskId, draft: NoteDraft) => void;
}

/**
 * Holds each Task's unsent note in the component that shows both the drawer and the Workbench
 * (STD-REACT-003), so a note begun in one is still there in the other and goes out under one key.
 */
export const useNoteDrafts = (): NoteDrafts => {
  const [drafts, setDrafts] = useState<ReadonlyMap<TaskId, NoteDraft>>(new Map());
  return {
    get: (taskId) => drafts.get(taskId) ?? emptyNote(),
    set: (taskId, draft) => setDrafts((all) => new Map(all).set(taskId, draft)),
  };
};

/**
 * The box where you leave a note on a Task for its lead (ADR 018). With `nudges`, each one is a
 * note sent with one tap (ADR 023). A nudge keeps its key until the hub has it, so tapping it again
 * after a lost reply leaves it once.
 */
export function NoteBox({
  tree,
  task,
  hobs,
  draft,
  setDraft,
  nudges = [],
  hint,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  draft: NoteDraft;
  setDraft: (draft: NoteDraft) => void;
  nudges?: ReadonlyArray<string>;
  /** What the line under the box says while nothing was just sent. */
  hint?: string | undefined;
}) {
  const lead = hobs(noteRecipient(tree, task));
  const send = useLeaveNote(task.id);
  const [nudgeKeys, setNudgeKeys] = useState<ReadonlyMap<string, NoteId>>(new Map());
  const [nudged, setNudged] = useState<string | null>(null);
  const text = draft.text.trim();
  const submit = () => {
    if (text === "" || send.isPending) return;
    setNudged(null);
    send.mutate({ key: draft.key, text }, { onSuccess: () => setDraft(emptyNote()) });
  };
  const nudge = (words: string) => {
    if (send.isPending) return;
    const key = nudgeKeys.get(words) ?? NoteId.make(crypto.randomUUID());
    setNudgeKeys((all) => new Map(all).set(words, key));
    setNudged(null);
    send.mutate(
      { key, text: words },
      {
        onSuccess: () => {
          setNudgeKeys((all) => {
            const rest = new Map(all);
            rest.delete(words);
            return rest;
          });
          setNudged(words);
        },
      },
    );
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
      {nudges.length > 0 && (
        <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0 pb-1">
          <legend className="sr-only">{copy.nudges}</legend>
          {nudges.map((words) => (
            <Button
              key={words}
              type="button"
              variant="chip"
              size="xs"
              // Never disabled while one sends, so focus stays on the nudge; a tap meanwhile does nothing.
              aria-disabled={send.isPending}
              onClick={() => nudge(words)}
            >
              {words}
            </Button>
          ))}
        </fieldset>
      )}
      <span className="flex gap-2">
        <Textarea
          aria-label={copy.noteLabel({ name: lead.name })}
          placeholder={copy.noteLabel({ name: lead.name })}
          value={draft.text}
          onChange={(event) => {
            setNudged(null);
            setDraft({ ...emptyNote(), text: event.target.value });
          }}
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
          : send.isSuccess && nudged !== null
            ? copy.nudgeSent({ words: nudged, name: lead.name })
            : send.isSuccess && draft.text === ""
              ? copy.sent({ name: lead.name })
              : (hint ?? copy.noteHint({ name: lead.name }))}
      </span>
    </form>
  );
}
