import { Button } from "@hobbots/ui/components/button";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { sendable, useDraft, writeDraft } from "../api/drafts.ts";
import type { WaitingPlace } from "../api/outbox.ts";
import { messages } from "./messages.ts";

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

/** The line under the input, which says what Enter and Stop do right now. */
const hintFor = (busy: boolean, stopping: boolean, paused: PausedHob | undefined): string => {
  if (busy) return stopping ? copy.hintStopping : copy.hintBusy;
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
  place,
  lastSent,
  placeholder,
  busy,
  stopping,
  sending,
  onSend,
  onStop,
  paused,
}: {
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
  paused?: PausedHob | undefined;
}) {
  const draft = useDraft(place);
  const input = useRef<HTMLTextAreaElement>(null);
  const closed = paused !== undefined && !paused.canQueue;
  const content = sendable(draft);

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

  return (
    <div className="flex flex-none flex-col gap-1.5 px-6 pt-2 pb-3.5">
      <div className="flex items-end gap-2.5">
        <textarea
          ref={input}
          aria-label={placeholder}
          value={draft}
          rows={1}
          spellCheck
          disabled={closed}
          placeholder={paused && closed ? copy.pausedPlaceholder(paused) : placeholder}
          onChange={(event) => writeDraft(place, event.target.value)}
          onKeyDown={onKeyDown}
          className="field-sizing-content max-h-40 min-h-[47px] flex-1 resize-none overflow-y-auto border-2 border-control bg-deep px-3.5 py-[11px] [overflow-wrap:anywhere] whitespace-pre-wrap text-text [tab-size:4] placeholder:text-label disabled:cursor-not-allowed disabled:border-line disabled:opacity-70"
        />
        {busy && (
          <Button variant="deny" onClick={onStop} disabled={stopping} className="px-4 py-[9px]">
            {stopping ? copy.stopping : copy.stop}
          </Button>
        )}
        {paused && (
          <Button variant={paused.canQueue ? "outline" : "default"} onClick={paused.onWake} disabled={paused.waking}>
            {copy.wake(paused)}
          </Button>
        )}
        {!closed && (
          <Button onClick={submit} disabled={!content || sending}>
            {paused ? copy.queue : copy.send}
          </Button>
        )}
      </div>
      <span className="text-xs text-label">{hintFor(busy, stopping, paused)}</span>
    </div>
  );
}
