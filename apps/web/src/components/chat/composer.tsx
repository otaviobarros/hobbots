import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { sendable, useDraft, writeDraft } from "../../api/drafts.ts";
import type { WaitingPlace } from "../../api/outbox.ts";
import type { ReplyWait } from "../../lib/reply-wait.ts";
import { messages } from "../messages.ts";
import { SkillPickerList, UseSkillButton, useSkillPicker } from "../skill-line/skill-picker.tsx";
import type { SkillPicking } from "../skill-line/skill-picker-model.ts";
import { SendIcon } from "./chat-icons.tsx";
import { BusyHint, StopButton } from "./composer-busy.tsx";

const copy = messages.composer;

/**
 * A paused hob takes no new work. In a thread the composer queues messages until the hob wakes,
 * with Wake beside it; a new thread waits for Wake. While a reply runs, Send queues the message
 * behind it (CH-008).
 */
export interface PausedHob {
  readonly name: string;
  readonly waking: boolean;
  readonly onWake: () => void;
  /** False before the thread exists: a paused hob starts no new thread. */
  readonly canQueue: boolean;
}

/** The paused hob's line under the input, or the keys' hint while nothing runs. */
const restingHint = (paused: PausedHob | undefined): string => {
  if (!paused) return copy.hint;
  return paused.canQueue ? copy.hintPausedQueue(paused) : copy.hintPausedNew(paused);
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
  busy,
  stopping,
  sending,
  onSend,
  onStop,
  wait = null,
  onStopWaiting,
  paused,
  skills,
}: {
  /** The hob's name, which the hint and Stop's description use. */
  name: string;
  /** Whose draft this is: the thread, or the hob's fresh page. */
  place: WaitingPlace;
  /** The last message sent in this thread, which Up brings back. */
  lastSent: string | undefined;
  placeholder: string;
  busy: boolean;
  /** Stop was pressed and the reply has not ended yet. */
  stopping: boolean;
  sending: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  /** What the reply waits on once its hob has answered, if only commands keep it open (#1056). */
  wait?: ReplyWait | null;
  /** Stop waiting: ends a reply that only waits on commands, keeping its text. */
  onStopWaiting?: () => void;
  paused?: PausedHob | undefined;
  /** The hob's skills, which `/` picks one of (ADR 029); absent, `/` is plain text. */
  skills?: SkillPicking | undefined;
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
  const closed = paused !== undefined && !paused.canQueue;
  const content = sendable(draft);
  const sendLabel = busy ? copy.sendAfterReply : copy.send;

  // Focus comes back to the input when a reply ends, unless the user has moved it somewhere else
  // or is selecting text to copy.
  useEffect(() => {
    const active = document.activeElement;
    const selecting = window.getSelection()?.isCollapsed === false;
    if (!busy && !selecting && (active === null || active === document.body)) input.current?.focus();
  }, [busy]);

  const submit = () => {
    if (!content || sending || closed) return;
    onSend(content);
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
          placeholder={paused && closed ? copy.pausedPlaceholder(paused) : placeholder}
          onChange={(event) => writeDraft(place, event.target.value)}
          onKeyDown={picker.around(onKeyDown)}
          className="field-sizing-content max-h-40 min-h-12 resize-none overflow-y-auto border-0 bg-transparent py-0.5 [overflow-wrap:anywhere] whitespace-pre-wrap text-text-strong outline-none [tab-size:4] placeholder:text-label disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2">
          <UseSkillButton
            picking={skills}
            hidden={closed}
            onClick={() => {
              picker.start();
              input.current?.focus();
            }}
          />
          {busy ? (
            <BusyHint name={name} stopping={stopping} drafting={content !== ""} wait={wait} />
          ) : (
            // Beside the Quest room the chat is narrow, so the keys' hint gives way to the message; a
            // paused hob's hint stays.
            <span
              className={cn("min-w-0 flex-1 text-end text-meta text-label", !paused && "@max-[480px]/chat:invisible")}
            >
              {restingHint(paused)}
            </span>
          )}
          {busy && (
            <StopButton name={name} stopping={stopping} wait={wait} onStop={onStop} onStopWaiting={onStopWaiting} />
          )}
          {paused && (
            <Button
              variant={paused.canQueue ? "outline" : "default"}
              size="bar"
              onClick={paused.onWake}
              disabled={paused.waking}
            >
              {copy.wake(paused)}
            </Button>
          )}
          {!closed &&
            (paused ? (
              <Button size="bar" onClick={submit} disabled={!content || sending}>
                {copy.queue}
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label={sendLabel}
                title={sendLabel}
                onClick={submit}
                disabled={!content || sending}
                className="size-[34px]"
              >
                <SendIcon />
              </Button>
            ))}
        </div>
      </div>
    </>
  );
}
