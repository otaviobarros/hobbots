import { isTerminalTask, type Task, type TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useEffect, useRef } from "react";
import { formatTime } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages as questMessages } from "../quest/messages.ts";
import { NoteBox, type NoteDrafts } from "../quest/note-box.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { noteRecipient, taskDetail, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.chat;

/**
 * The Task chat drawer on the Workbench (ADR 023): talk about this Task without leaving it. What
 * you write, or a quick nudge, goes to the Task as a note (ADR 018), so it reaches the Task's
 * nearest lead, never a party member directly. Your notes on the Task show above the box. Once the
 * work has ended, nobody is left to read a note, so the box gives way to a line saying so.
 */
export function WorkbenchChat({
  id,
  tree,
  task,
  hobs,
  drafts,
  onClose,
}: {
  id: string;
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  drafts: NoteDrafts;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const title = taskTitle(task);
  const leadId = noteRecipient(tree, task);
  const lead = hobs(leadId);
  const owner = hobs(task.ownerId);
  const notes = taskDetail(tree, task).notes;
  const ended = isTerminalTask(tree.tasks[0]?.state ?? task.state);
  // Opening the chat moves focus into it, so a keyboard user lands where they can write.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <aside
      id={id}
      aria-label={copy.label({ title })}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape closes the chat first; a second one leaves the Workbench.
        event.preventDefault();
        onClose();
      }}
      className="flex w-workbench-chat max-w-[45%] shrink-0 animate-hb-in flex-col border-s-4 border-line bg-panel"
    >
      <header className="flex items-center gap-2.5 border-b-2 border-line px-3.5 py-3">
        <HobSprite hob={lead} size={26} />
        <span className="flex min-w-0 flex-1 flex-col">
          <h3 ref={heading} tabIndex={-1} className="m-0 truncate text-sm font-bold outline-none">
            {copy.heading({ name: lead.name })}
          </h3>
          <span className="truncate text-xs text-label">{copy.about({ title })}</span>
        </span>
        <Button variant="icon" size="icon" onClick={onClose} aria-label={copy.close} title={copy.close}>
          ✕
        </Button>
      </header>
      <ol
        aria-label={copy.notes}
        className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2.5 overflow-y-auto px-3.5 py-3 text-sm leading-snug"
      >
        {notes.length === 0 ? (
          <li className="text-detail text-label">{copy.empty({ name: lead.name })}</li>
        ) : (
          notes.map((note) => (
            <li key={note.id} className="flex flex-col items-end gap-1">
              <span className="cut max-w-[90%] bg-line px-2.5 py-1.5 whitespace-pre-wrap text-text">{note.text}</span>
              <span className="text-xs text-label">
                {questMessages.drawer.noteTo({ name: hobs(note.recipientId).name, time: formatTime(note.createdAt) })}
              </span>
            </li>
          ))
        )}
      </ol>
      {ended ? (
        <p className="m-0 border-t-2 border-line px-3.5 py-3 text-detail text-secondary-text">
          {questMessages.drawer.noteRefused({ name: lead.name })}
        </p>
      ) : (
        <NoteBox
          key={task.id}
          tree={tree}
          task={task}
          hobs={hobs}
          draft={drafts.get(task.id)}
          setDraft={(draft) => drafts.set(task.id, draft)}
          nudges={copy.nudges}
          hint={
            leadId === task.ownerId
              ? copy.hintOwner({ name: lead.name })
              : copy.hintLead({ lead: lead.name, owner: owner.name })
          }
        />
      )}
    </aside>
  );
}
