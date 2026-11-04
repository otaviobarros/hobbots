import { isTerminalTask, type Question, type Task, type TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatTime } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages as questMessages } from "../quest/messages.ts";
import { NoteBox, type NoteDrafts } from "../quest/note-box.tsx";
import { AnswerForm } from "../quest/question-card.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { noteRecipient, questionForYou, taskDetail, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.chat;

/**
 * The Task chat drawer on the Workbench (ADR 023): talk about this Task without leaving it. What
 * you write, or a quick nudge, goes to the Task as a note (ADR 018), so it reaches the Task's
 * nearest lead, never a party member directly. Your notes on the Task show above the box. While a
 * question on the Task waits for you, the footer holds the question and its answer box instead, so
 * an answer is never sent as a note; "Send a note to <lead> instead" swaps in the note box. Once the
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
  const question = ended ? null : questionForYou(tree, task);
  const asker = question === null ? null : hobs(question.askerId);
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
      className="flex w-workbench-chat max-w-full shrink-0 animate-hb-in flex-col border-s border-line bg-panel @max-[480px]/bench:absolute @max-[480px]/bench:inset-y-0 @max-[480px]/bench:end-0 @max-[480px]/bench:z-20 @max-[480px]/bench:shadow-menu @min-[480px]/bench:max-w-[45%]"
    >
      <header className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
        <HobSprite hob={lead} size={26} />
        <span className="flex min-w-0 flex-1 flex-col">
          <h3 ref={heading} tabIndex={-1} className="m-0 truncate text-ui font-bold text-text-strong outline-none">
            {copy.heading}
          </h3>
          <span className={asker === null ? "text-meta text-label" : "text-meta font-semibold text-lantern"}>
            {asker === null ? copy.notesGo({ name: lead.name }) : copy.waiting({ name: asker.name })}
          </span>
        </span>
        <Button variant="icon" size="icon" onClick={onClose} aria-label={copy.close} title={copy.close}>
          ✕
        </Button>
      </header>
      <ol
        aria-label={copy.notes}
        className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2.5 overflow-y-auto px-3.5 py-3 text-ui leading-snug"
      >
        {notes.length === 0 ? (
          <li className="text-detail text-label">{copy.empty({ name: lead.name })}</li>
        ) : (
          notes.map((note) => (
            <li key={note.id} className="flex flex-col items-end gap-1">
              <span className="cut max-w-[90%] bg-line px-2.5 py-1.5 whitespace-pre-wrap text-text-strong">
                {note.text}
              </span>
              <span className="text-meta text-label">
                {questMessages.drawer.noteTo({ name: hobs(note.recipientId).name, time: formatTime(note.createdAt) })}
              </span>
            </li>
          ))
        )}
      </ol>
      {ended ? (
        <p className="m-0 border-t border-line px-3.5 py-3 text-detail text-text-secondary">
          {questMessages.drawer.noteRefused({ name: lead.name })}
        </p>
      ) : (
        <Footer
          key={`${task.id}-${question?.id ?? "note"}`}
          question={question}
          askerName={asker?.name ?? ""}
          leadName={lead.name}
          note={(waiting) => (
            <NoteBox
              key={task.id}
              tree={tree}
              task={task}
              hobs={hobs}
              draft={drafts.get(task.id)}
              setDraft={(draft) => drafts.set(task.id, draft)}
              nudges={waiting ? [] : copy.nudges}
              nudgeKeys={drafts.nudges(task.id)}
              {...(waiting && asker !== null
                ? {
                    label: questMessages.drawer.noteNotAnswer({ name: lead.name }),
                    hint: copy.noteNotAnswerHint({ lead: lead.name, asker: asker.name }),
                  }
                : {
                    hint:
                      leadId === task.ownerId
                        ? copy.hintOwner({ name: lead.name })
                        : copy.hintLead({ lead: lead.name, owner: owner.name }),
                  })}
            />
          )}
        />
      )}
    </aside>
  );
}

/**
 * The chat's footer: the note box, or while a question waits for you, the question with its answer
 * box (the one the chat's card and the Task drawer use) and a way to send the lead a note instead.
 */
function Footer({
  question,
  askerName,
  leadName,
  note,
}: {
  question: Question | null;
  askerName: string;
  leadName: string;
  /** The note box; `waiting` says a question still waits, so the box names itself not an answer. */
  note: (waiting: boolean) => ReactNode;
}) {
  const [noting, setNoting] = useState(false);
  if (question === null) return note(false);
  if (noting) {
    return (
      <div className="flex flex-col">
        {note(true)}
        <Button variant="link" size="xs" className="self-start px-3.5 pb-3" onClick={() => setNoting(false)}>
          {copy.answerInstead({ name: askerName })}
        </Button>
      </div>
    );
  }
  return (
    <section
      aria-label={copy.asks({ name: askerName })}
      className="flex flex-col gap-2 border-t border-lantern bg-lantern/8 px-3.5 py-3"
    >
      <span className="lbl text-meta font-bold text-lantern">{copy.asks({ name: askerName })}</span>
      <p className="m-0 text-ui leading-snug whitespace-pre-wrap text-text-strong">{question.text}</p>
      <AnswerForm question={question} askerName={askerName} via="task" />
      <Button variant="link" size="xs" className="self-start" onClick={() => setNoting(true)}>
        {copy.noteInstead({ name: leadName })}
      </Button>
    </section>
  );
}
