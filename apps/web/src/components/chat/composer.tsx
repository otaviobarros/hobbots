import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { sendable, useDraft, writeDraft } from "../../api/drafts.ts";
import type { WaitingPlace } from "../../api/outbox.ts";
import { messages } from "../messages.ts";
import { SendIcon } from "./chat-icons.tsx";

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
 * While a reply runs, the hint is one line that never wraps: a blinking mint dot and who is
 * replying, or when a draft will go. Beside the Quest room it keeps only the dot and one word. The
 * longer sentence is Stop's description.
 */
function BusyHint({ name, stopping, drafting }: { name: string; stopping: boolean; drafting: boolean }) {
  const full = stopping ? copy.hintStopping({ name }) : drafting ? copy.hintSendsAfter : copy.hintReplying({ name });
  return (
    <span
      aria-live="polite"
      className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-meta whitespace-nowrap text-text-secondary"
    >
      {!stopping && <span aria-hidden className="size-2 flex-none animate-hb-blink rounded-dot bg-mint" />}
      <span className="truncate @max-[480px]/chat:hidden">{full}</span>
      <span className="hidden truncate @max-[480px]/chat:inline">
        {stopping ? copy.hintStoppingShort : copy.hintReplyingShort}
      </span>
    </span>
  );
}

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
  paused,
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
  paused?: PausedHob | undefined;
}) {
  const draft = useDraft(place);
  const input = useRef<HTMLTextAreaElement>(null);
  const closed = paused !== undefined && !paused.canQueue;
  const content = sendable(draft);
  const stopWhat = useId();
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
    <div
      data-composer=""
      className="cut focus-ring-within flex flex-none flex-col gap-1 border-(length:--edge) border-line-2 bg-card py-2 ps-4 pe-2.5 focus-within:border-focus-ring has-[textarea:disabled]:border-line has-[textarea:disabled]:opacity-70"
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
        onKeyDown={onKeyDown}
        className="field-sizing-content max-h-40 min-h-12 resize-none overflow-y-auto border-0 bg-transparent py-0.5 [overflow-wrap:anywhere] whitespace-pre-wrap text-text-strong outline-none [tab-size:4] placeholder:text-label disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-2">
        {busy ? (
          <BusyHint name={name} stopping={stopping} drafting={content !== ""} />
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
          <>
            <Button
              variant="deny"
              size="bar"
              onClick={onStop}
              disabled={stopping}
              aria-describedby={stopWhat}
              title={copy.stopDescription({ name })}
            >
              {stopping ? copy.stopping : copy.stop}
            </Button>
            <span id={stopWhat} hidden>
              {copy.stopDescription({ name })}
            </span>
          </>
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
  );
}
