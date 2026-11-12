import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { sendable, useDraft, writeDraft } from "../../api/drafts.ts";
import type { WaitingPlace } from "../../api/outbox.ts";
import { type ReplyRun, replyRuns } from "../../lib/reply-wait.ts";
import { messages } from "../messages.ts";
import { messages as noteCopy } from "../notes/messages.ts";
import type { NoteMode } from "../notes/use-note-to-self.ts";
import { SkillPickerList, UseSkillButton, useSkillPicker } from "../skill-line/skill-picker.tsx";
import type { SkillPicking } from "../skill-line/skill-picker-model.ts";
import { ComposerActions, ComposerHint, NoteToggle, type PausedHob } from "./composer-parts.tsx";

const copy = messages.composer;

const sendLabelOf = (noting: boolean, busy: boolean): string => {
  if (noting) return noteCopy.save;
  return busy ? copy.sendAfterReply : copy.send;
};

/** The input's placeholder: a note's, a closed paused hob's, or the thread's own. */
const placeholderOf = (own: string, noting: boolean, closedBy: PausedHob | undefined): string => {
  if (noting) return noteCopy.placeholder;
  return closedBy ? copy.pausedPlaceholder(closedBy) : own;
};

/**
 * Plain text in, exactly as typed: no Markdown, and a paste keeps its text, line breaks and tabs.
 * The input grows with its text up to its height limit and then scrolls. Enter sends, Shift+Enter
 * adds a line, and a key that finishes an IME composition never sends. Each thread keeps its own
 * unsent draft, and Up on an empty input brings back the last message sent there to edit.
 */
export function Composer({
  name,
  place,
  lastSent,
  placeholder,
  run,
  sending,
  onSend,
  onStop,
  onStopWaiting,
  paused,
  skills,
  note,
}: {
  /** The hob's name, which the hint and Stop's description use. */
  name: string;
  /** Whose draft this is: the thread, or the hob's fresh page. */
  place: WaitingPlace;
  /** The last message sent in this thread, which Up brings back. */
  lastSent: string | undefined;
  placeholder: string;
  /** The thread's reply: none, at work, waiting only on commands (#1056), or stopping. */
  run: ReplyRun;
  sending: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  /** Stop waiting: ends a reply that only waits on commands, keeping its text. */
  onStopWaiting?: () => void;
  paused?: PausedHob | undefined;
  /** The hob's skills, which `/` picks one of (ADR 029); absent, `/` is plain text. */
  skills?: SkillPicking | undefined;
  /** Notes to self (ADR 037): the composer writes one while it is on. Absent before the thread exists. */
  note?: NoteMode | undefined;
}) {
  const draft = useDraft(place);
  const input = useRef<HTMLTextAreaElement>(null);
  // Where the picker wants the cursor once the draft it wrote is in the input.
  const cursorAt = useRef<number | null>(null);
  const picker = useSkillPicker(draft, skills, (next, cursor) => {
    cursorAt.current = cursor;
    writeDraft(place, next);
  });
  useLayoutEffect(() => {
    if (cursorAt.current === null || input.current === null || input.current.value !== draft) return;
    input.current.setSelectionRange(cursorAt.current, cursorAt.current);
    cursorAt.current = null;
  }, [draft]);
  const noting = note?.on === true;
  // A note wakes no hob, so it goes whatever the hob is doing.
  const closed = !noting && paused !== undefined && !paused.canQueue;
  const content = sendable(draft);
  const busy = replyRuns(run);
  const sendLabel = sendLabelOf(noting, busy);

  // Focus comes back to the input when a reply ends, unless the user has moved it somewhere else
  // or is selecting text to copy.
  useEffect(() => {
    const active = document.activeElement;
    const selecting = window.getSelection()?.isCollapsed === false;
    if (!busy && !selecting && (active === null || active === document.body)) input.current?.focus();
  }, [busy]);

  const submit = () => {
    if (noting) {
      if (content && !note.saving) note.onNote(content);
    } else if (content && !sending && !closed) onSend(content);
    else return;
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME composes, Enter picks a candidate; it is not a send. Safari ends the composition
    // before that Enter arrives and marks it with key code 229 instead.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "ArrowUp" && plain && draft === "" && lastSent !== undefined) {
      event.preventDefault();
      writeDraft(place, lastSent);
    }
  };

  // A card in the skin's corners and edge, with the hint and an icon Send inside it (A2-03).
  return (
    <>
      <SkillPickerList picking={skills} picker={picker} />
      <div
        data-composer=""
        className="cut focus-ring-within flex flex-none flex-col gap-1 border-(length:--edge) border-line-2 bg-card py-2 ps-4 pe-2.5 focus-within:border-focus-ring has-[textarea:disabled]:border-line"
      >
        <textarea
          ref={input}
          aria-label={placeholder}
          value={draft}
          rows={2}
          spellCheck
          disabled={closed}
          placeholder={placeholderOf(placeholder, noting, closed ? paused : undefined)}
          onChange={(event) => writeDraft(place, event.target.value)}
          onKeyDown={picker.around(onKeyDown)}
          className="field-sizing-content max-h-40 min-h-12 resize-none overflow-y-auto border-0 bg-transparent py-0.5 [overflow-wrap:anywhere] whitespace-pre-wrap text-text-strong outline-none [tab-size:4] placeholder:text-label disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2">
          <UseSkillButton
            picking={skills}
            hidden={closed || noting}
            onClick={() => {
              picker.start();
              input.current?.focus();
            }}
          />
          {note && (
            <NoteToggle
              note={note}
              busy={busy}
              onToggle={() => {
                note.onToggle();
                input.current?.focus();
              }}
            />
          )}
          <ComposerHint name={name} noting={noting} run={run} drafting={content !== ""} paused={paused} />
          <ComposerActions
            name={name}
            noting={noting}
            closed={closed}
            run={run}
            paused={paused}
            sendLabel={sendLabel}
            disabled={!content || (noting ? note.saving : sending)}
            onSubmit={submit}
            onStop={onStop}
            onStopWaiting={onStopWaiting}
          />
        </div>
      </div>
      {note?.status && (
        <p role="status" className="m-0 text-meta text-label">
          {note.status}
        </p>
      )}
    </>
  );
}
