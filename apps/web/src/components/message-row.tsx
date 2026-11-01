import { type Agent, isInProgress, type Message } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { toolLogUrl } from "../api/client.ts";
import { formatTime, refillText } from "../lib/time.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { ReplyMarkdown } from "./markdown/reply-markdown.tsx";
import { messages } from "./messages.ts";
import { ReplySteps } from "./reply-steps.tsx";

const copy = messages.reply;

/** The element id of a message's row, for scrolling to it. */
export const messageElementId = (id: string) => `message-${id}`;

// A message opened from search wears a lantern outline, so the eye finds it.
const focusRing = "outline-2 outline-offset-4 outline-lantern";

/**
 * Continuing a reply that was cut off: offered on the thread's latest reply only, on its brain or,
 * through `alternatives`, on another one that is ready (ADR 017).
 */
export type ContinueReply = {
  readonly pending: boolean;
  readonly onContinue: () => void;
  readonly alternatives?: ReadonlyArray<{ readonly label: string; readonly onContinue: () => void }>;
};

/**
 * One message; `focused` marks the one a search result opened. A reply shows `children` under its
 * steps, such as the approval cards its tool calls are waiting on.
 */
export function MessageRow({
  message,
  hob,
  focused = false,
  resume,
  children,
}: {
  message: Message;
  hob: Agent;
  focused?: boolean;
  resume?: ContinueReply | undefined;
  children?: ReactNode;
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

  return (
    <ReplyRow message={message} hob={hob} id={id} focused={focused} resume={resume}>
      {children}
    </ReplyRow>
  );
}

function ReplyRow({
  message,
  hob,
  id,
  focused,
  resume,
  children,
}: {
  message: Message;
  hob: Agent;
  id: string;
  focused: boolean;
  resume: ContinueReply | undefined;
  children: ReactNode;
}) {
  const streaming = isInProgress(message.status);
  const writing = message.status === "streaming";
  return (
    <div id={id} className={cn("flex max-w-[640px] animate-hb-in gap-2.5", focused && focusRing)}>
      <HobSprite hob={hob} size={26} state={streaming ? "working" : message.status === "failed" ? "failed" : "idle"} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-xs text-label">
          <b className="font-pixel text-sm text-moonlight">{hob.name}</b> {formatTime(message.createdAt)}
        </span>
        <ReplySteps
          steps={message.steps}
          inProgress={streaming}
          logUrl={(stepId) => toolLogUrl(message.threadId, message.id, stepId)}
        />
        {children}
        {writing && message.content.length === 0 ? (
          message.steps.length === 0 && <Thinking name={hob.name} />
        ) : (
          <ReplyMarkdown content={message.content} streaming={streaming} caret={writing} />
        )}
        {message.status === "stopping" && (
          <span role="status" className="flex items-center gap-2 text-[13px] text-lantern">
            <span aria-hidden className="size-[5px] animate-hb-blink bg-lantern" />
            {copy.stopping}
          </span>
        )}
        {message.status === "stopped" && (
          <span role="status" className="animate-hb-in text-[13px] text-lantern">
            {copy.stopped({ name: hob.name })}
          </span>
        )}
        {message.status === "interrupted" && (
          <span className="animate-hb-in text-[13px] text-rose">
            {message.error === null ? copy.interrupted({ name: hob.name }) : copy.cutOff({ error: message.error })}
          </span>
        )}
        {message.status === "limited" && (
          <span role="status" className="animate-hb-in text-[13px] text-lantern">
            {copy.limited({
              name: hob.name,
              provider: providerName(message),
              refill: refillText(message.resetsAt),
            })}
          </span>
        )}
        {resume && <ResumeControls resume={resume} name={hob.name} />}
        {message.status === "failed" && (
          <span className="animate-hb-in text-[13px] text-rose">{copy.failed({ error: message.error })}</span>
        )}
      </div>
    </div>
  );
}

/** The provider whose limit ended a reply, in the user's words. */
const providerName = (message: Message) => (message.runtime === "codex" ? "Codex" : "Claude");

/** Continue for a reply that ended early, and Continue with each other ready brain. */
function ResumeControls({ resume, name }: { resume: ContinueReply; name: string }) {
  return resume.pending ? (
    <span role="status" className="flex items-center gap-2 text-[13px] text-secondary-text">
      <span aria-hidden className="size-[5px] animate-hb-blink bg-mint" />
      {copy.resuming({ name })}
    </span>
  ) : (
    <span className="flex gap-2 pt-1">
      <Button variant="outline" size="xs" onClick={resume.onContinue}>
        {copy.continue}
      </Button>
      {resume.alternatives?.map((alternative) => (
        <Button key={alternative.label} variant="outline" size="xs" onClick={alternative.onContinue}>
          {alternative.label}
        </Button>
      ))}
    </span>
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
      aria-label={messages.queued.label}
      className="flex max-w-[460px] animate-hb-in flex-col items-end gap-1.5 self-end"
    >
      <div className="bg-line px-3.5 py-2.5 leading-[1.45] whitespace-pre-wrap opacity-80">{message.content}</div>
      <span className="text-xs text-label">
        {paused ? messages.queued.waitsForWake({ name: hob.name }) : messages.queued.readsNext({ name: hob.name })}
      </span>
      <span className="flex gap-2">
        <Button variant="outline" size="xs" onClick={onRemove} disabled={pending}>
          {messages.queued.remove}
        </Button>
        {!paused && (
          <Button variant="outline" size="xs" onClick={onSendNow} disabled={pending}>
            {replying ? messages.queued.sendNowAndInterrupt : messages.queued.sendNow}
          </Button>
        )}
      </span>
    </section>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <span role="status" className="flex items-center gap-2.5 text-sm text-secondary-text">
      {copy.thinking({ name })}
      <span aria-hidden className="flex gap-1">
        <span className="size-[5px] animate-hb-blink bg-mint" />
        <span className="size-[5px] animate-hb-blink bg-mint [animation-delay:.3s]" />
        <span className="size-[5px] animate-hb-blink bg-mint [animation-delay:.6s]" />
      </span>
    </span>
  );
}
