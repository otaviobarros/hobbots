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

/**
 * The keys of a Task's nudges the hub has not confirmed. A nudge keeps its key until the hub has
 * it, so tapping it again after a lost reply leaves it once, even after the chat was closed.
 */
export interface NudgeKeys {
  /** The key a nudge goes out under: the one it was last sent under, or a new one. */
  readonly take: (words: string) => NoteId;
  /** The hub has the nudge, so the next tap is a new note. */
  readonly settle: (words: string) => void;
}

/** Each Task's unsent note and nudges, shared by the drawer and the Workbench so both show the same. */
export interface NoteDrafts {
  readonly get: (taskId: TaskId) => NoteDraft;
  readonly set: (taskId: TaskId, draft: NoteDraft) => void;
  readonly nudges: (taskId: TaskId) => NudgeKeys;
}

/**
 * Holds each Task's unsent note and unconfirmed nudge keys in the component that shows both the
 * drawer and the Workbench (STD-REACT-003), so they outlive either and go out under one key.
 */
export const useNoteDrafts = (): NoteDrafts => {
  const [drafts, setDrafts] = useState<ReadonlyMap<TaskId, NoteDraft>>(new Map());
  const [nudgeKeys, setNudgeKeys] = useState<ReadonlyMap<string, NoteId>>(new Map());
  const nudgeId = (taskId: TaskId, words: string) => JSON.stringify([taskId, words]);
  return {
    get: (taskId) => drafts.get(taskId) ?? emptyNote(),
    set: (taskId, draft) => setDrafts((all) => new Map(all).set(taskId, draft)),
    nudges: (taskId) => ({
      take: (words) => {
        const id = nudgeId(taskId, words);
        const key = nudgeKeys.get(id) ?? NoteId.make(crypto.randomUUID());
        setNudgeKeys((all) => new Map(all).set(id, key));
        return key;
      },
      settle: (words) =>
        setNudgeKeys((all) => {
          const rest = new Map(all);
          rest.delete(nudgeId(taskId, words));
          return rest;
        }),
    }),
  };
};

/**
 * The box where you leave a note on a Task for its lead (ADR 018). With `nudges`, each one is a
 * note sent with one tap (ADR 023), under the key `nudgeKeys` keeps for it.
 */
export function NoteBox({
  tree,
  task,
  hobs,
  draft,
  setDraft,
  nudges = [],
  nudgeKeys,
  hint,
  label,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  draft: NoteDraft;
  setDraft: (draft: NoteDraft) => void;
  nudges?: ReadonlyArray<string>;
  nudgeKeys?: NudgeKeys | undefined;
  /** What the line under the box says while nothing was just sent. */
  hint?: string | undefined;
  /** The box's name, when it must say more than who the note goes to. */
  label?: string | undefined;
}) {
  const lead = hobs(noteRecipient(tree, task));
  const boxName = label ?? copy.noteLabel({ name: lead.name });
  const send = useLeaveNote(task.id);
  const [nudged, setNudged] = useState<string | null>(null);
  const text = draft.text.trim();
  const submit = () => {
    if (text === "" || send.isPending) return;
    setNudged(null);
    send.mutate({ key: draft.key, text }, { onSuccess: () => setDraft(emptyNote()) });
  };
  const nudge = (words: string) => {
    if (send.isPending || nudgeKeys === undefined) return;
    const key = nudgeKeys.take(words);
    setNudged(null);
    send.mutate(
      { key, text: words },
      {
        onSuccess: () => {
          nudgeKeys.settle(words);
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
      {nudgeKeys !== undefined && nudges.length > 0 && (
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
          aria-label={boxName}
          placeholder={boxName}
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
