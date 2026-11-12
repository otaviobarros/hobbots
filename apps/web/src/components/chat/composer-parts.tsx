import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReplyWait } from "../../lib/reply-wait.ts";
import { messages } from "../messages.ts";
import { messages as noteCopy } from "../notes/messages.ts";
import type { NoteMode } from "../notes/use-note-to-self.ts";
import { NoteIcon, SendIcon } from "./chat-icons.tsx";
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

/** The line beside the composer's buttons: the note's hint, the running reply, or the keys. */
export function ComposerHint({
  name,
  noting,
  busy,
  stopping,
  drafting,
  wait,
  paused,
}: {
  name: string;
  noting: boolean;
  busy: boolean;
  stopping: boolean;
  drafting: boolean;
  wait: ReplyWait | null;
  paused: PausedHob | undefined;
}) {
  if (noting) return <span className="min-w-0 flex-1 text-end text-meta text-label">{noteCopy.hint}</span>;
  if (busy) return <BusyHint name={name} stopping={stopping} drafting={drafting} wait={wait} />;
  // beside a quest's Workbench the chat is narrow, so the keys' hint gives way to the message; a paused
  // hob's hint stays.
  return (
    <span className={cn("min-w-0 flex-1 text-end text-meta text-label", !paused && "@max-[480px]/chat:invisible")}>
      {restingHint(paused)}
    </span>
  );
}

/** Stop, Wake, and Queue or Send. A note hides Stop and Wake, since it wakes no hob. */
export function ComposerActions({
  name,
  noting,
  closed,
  busy,
  stopping,
  wait,
  paused,
  sendLabel,
  disabled,
  onSubmit,
  onStop,
  onStopWaiting,
}: {
  name: string;
  noting: boolean;
  /** A paused hob's new thread: nothing can be sent until it wakes. */
  closed: boolean;
  busy: boolean;
  stopping: boolean;
  wait: ReplyWait | null;
  paused: PausedHob | undefined;
  sendLabel: string;
  disabled: boolean;
  onSubmit: () => void;
  onStop: () => void;
  onStopWaiting: (() => void) | undefined;
}) {
  const hob = noting ? undefined : paused;
  return (
    <>
      {busy && !noting && (
        <StopButton name={name} stopping={stopping} wait={wait} onStop={onStop} onStopWaiting={onStopWaiting} />
      )}
      {hob && (
        <Button variant={hob.canQueue ? "outline" : "default"} size="bar" onClick={hob.onWake} disabled={hob.waking}>
          {copy.wake(hob)}
        </Button>
      )}
      {!closed &&
        (hob ? (
          <Button size="bar" onClick={onSubmit} disabled={disabled}>
            {copy.queue}
          </Button>
        ) : (
          <Button
            size="icon"
            aria-label={sendLabel}
            title={sendLabel}
            onClick={onSubmit}
            disabled={disabled}
            className="size-[34px]"
          >
            <SendIcon />
          </Button>
        ))}
    </>
  );
}

/**
 * Note to self: while it is pressed, what you send is saved under Mine and wakes no hob (ADR 037).
 * beside a quest's Workbench the chat is narrow, so it gives its words up for an icon, and while a reply
 * runs it steps aside to leave the busy hint and Stop their room.
 */
export function NoteToggle({ note, busy, onToggle }: { note: NoteMode; busy: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="icon"
      size="xs"
      aria-pressed={note.on}
      disabled={note.saving}
      onClick={onToggle}
      title={noteCopy.toggle}
      className={cn(busy && !note.on && "@max-[480px]/chat:hidden")}
    >
      <span className="@max-[480px]/chat:sr-only">{noteCopy.toggle}</span>
      <span className="hidden @max-[480px]/chat:contents">
        <NoteIcon />
      </span>
    </Button>
  );
}
