import { type Agent, isInProgress, type Message } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useReplySteps } from "../api/live.ts";
import { formatTime, refillText } from "../lib/time.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { ReplySteps } from "./reply-steps.tsx";

/** The element id of a message's row, for scrolling to it. */
export const messageElementId = (id: string) => `message-${id}`;

// A message opened from search wears a lantern outline, so the eye finds it.
const focusRing = "outline-2 outline-offset-4 outline-lantern";

/** Continuing a reply that was cut off: offered on the thread's latest reply only. */
export type ContinueReply = { readonly pending: boolean; readonly onContinue: () => void };

/** One message; `focused` marks the one a search result opened. */
export function MessageRow({
  message,
  hob,
  focused = false,
  resume,
}: {
  message: Message;
  hob: Agent;
  focused?: boolean;
  resume?: ContinueReply | undefined;
}) {
  const id = messageElementId(message.id);
  if (message.role === "user") {
    return (
      <div
        id={id}
        className={cn(
          "max-w-[460px] animate-hb-in self-end bg-line px-3.5 py-2.5 leading-[1.45] whitespace-pre-wrap",
          focused && focusRing,
        )}
      >
        {message.content}
      </div>
    );
  }

  return <ReplyRow message={message} hob={hob} id={id} focused={focused} resume={resume} />;
}

// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
function ReplyRow({
  message,
  hob,
  id,
  focused,
  resume,
}: {
  message: Message;
  hob: Agent;
  id: string;
  focused: boolean;
  resume: ContinueReply | undefined;
}) {
  const streaming = isInProgress(message.status);
  const writing = message.status === "streaming";
  // Steps are live only, so a finished reply shows none.
  const steps = useReplySteps(message.id);
  const liveSteps = streaming ? steps : [];
  return (
    <div id={id} className={cn("flex max-w-[640px] animate-hb-in gap-2.5", focused && focusRing)}>
      <HobSprite hob={hob} size={26} state={streaming ? "working" : message.status === "failed" ? "failed" : "idle"} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-xs text-label">
          <b className="font-pixel text-sm text-moonlight">{hob.name}</b> {formatTime(message.createdAt)}
        </span>
        <ReplySteps steps={liveSteps} />
        {writing && message.content.length === 0 ? (
          liveSteps.length === 0 && <Thinking name={hob.name} />
        ) : (
          <span className="leading-normal whitespace-pre-wrap">
            {message.content}
            {writing && (
              <span aria-hidden className="ml-0.5 inline-block h-4 w-2 animate-hb-caret bg-moonlight align-[-2px]" />
            )}
          </span>
        )}
        {message.status === "stopping" && (
          <span role="status" className="flex items-center gap-2 text-[13px] text-lantern">
            <span aria-hidden className="size-[5px] animate-hb-blink bg-lantern" />
            Stopping this reply…
          </span>
        )}
        {message.status === "stopped" && (
          <span role="status" className="animate-hb-pop origin-left text-[13px] text-lantern">
            ■ You stopped this reply. {hob.name} kept what it wrote so far.
          </span>
        )}
        {message.status === "interrupted" && (
          <span className="animate-hb-pop origin-left text-[13px] text-rose">
            {message.error === null
              ? `This reply was cut off, not by you: Hobbots restarted or ${hob.name} was paused. What it wrote so far is kept.`
              : `Answer cut off: ${message.error}. Nothing was lost before this point.`}
          </span>
        )}
        {message.status === "limited" && (
          <span role="status" className="animate-hb-pop origin-left text-[13px] text-lantern">
            ⚗ {hob.name} used up the Claude allowance for now. {refillText(message.resetsAt)} What it wrote so far is
            kept.
          </span>
        )}
        {resume &&
          (resume.pending ? (
            <span role="status" className="flex items-center gap-2 text-[13px] text-secondary-text">
              <span aria-hidden className="size-[5px] animate-hb-blink bg-mint" />
              Picking up where {hob.name} left off…
            </span>
          ) : (
            <span className="flex gap-2 pt-1">
              <Button variant="outline" size="xs" onClick={resume.onContinue}>
                Continue from here
              </Button>
            </span>
          ))}
        {message.status === "failed" && (
          <span className="animate-hb-pop origin-left text-[13px] text-rose">
            ✗ This reply failed: {message.error ?? "unknown error"}. Send your message again to retry.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A message waiting for the thread's running reply (CH-008). It can be taken back before it
 * starts, or sent now, which stops the running reply.
 */
export function QueuedRow({
  message,
  hob,
  replying,
  pending,
  onRemove,
  onSendNow,
}: {
  message: Message;
  hob: Agent;
  replying: boolean;
  pending: boolean;
  onRemove: () => void;
  onSendNow: () => void;
}) {
  const paused = hob.status !== "active";
  return (
    <section
      aria-label="Queued message"
      className="flex max-w-[460px] animate-hb-in flex-col items-end gap-1.5 self-end"
    >
      <div className="bg-line px-3.5 py-2.5 leading-[1.45] whitespace-pre-wrap opacity-80">{message.content}</div>
      <span className="text-xs text-label">
        {paused ? `◷ Queued. Waits until you wake ${hob.name}.` : `◷ Queued. ${hob.name} reads it after this reply.`}
      </span>
      <span className="flex gap-2">
        <Button variant="outline" size="xs" onClick={onRemove} disabled={pending}>
          Remove
        </Button>
        {!paused && (
          <Button variant="outline" size="xs" onClick={onSendNow} disabled={pending}>
            {replying ? "Send now and interrupt" : "Send now"}
          </Button>
        )}
      </span>
    </section>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <span role="status" className="flex items-center gap-2.5 text-sm text-secondary-text">
      {name} is thinking
      <span aria-hidden className="flex gap-1">
        <span className="size-[5px] animate-hb-blink bg-mint" />
        <span className="size-[5px] animate-hb-blink bg-mint [animation-delay:.3s]" />
        <span className="size-[5px] animate-hb-blink bg-mint [animation-delay:.6s]" />
      </span>
    </span>
  );
}
