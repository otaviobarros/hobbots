import { HOB_COLORS } from "@hobbots/art/look";
import { type Agent, isInProgress, type Message } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { type CSSProperties, type ReactNode, useEffect } from "react";
import { toolLogUrl } from "../../api/client.ts";
import { formatTime } from "../../lib/time.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { messages } from "../messages.ts";
import { limitRefill, planOf, usePlans } from "../usage/plan-summary.ts";
import { ReplySteps } from "./reply-steps.tsx";
import { SettleCharmCall } from "./settle-charm-call.tsx";

const copy = messages.reply;

/** The element id of a message's row, for scrolling to it. */
const messageElementId = (id: string) => `message-${id}`;

/** Scrolls the message a search opened into the middle of the view once a transcript holds it. */
export const useScrollToMessage = (messages: ReadonlyArray<{ readonly id: string }> | undefined, id?: string) => {
  const loaded = messages?.some((message) => message.id === id) ?? false;
  useEffect(() => {
    if (loaded && id) document.getElementById(messageElementId(id))?.scrollIntoView({ block: "center" });
  }, [loaded, id]);
};

// A message opened from search wears a lantern outline, so the eye finds it.
const focusRing = "outline-2 outline-offset-4 outline-lantern";

/** Your bubble: a card tinted with star, its corner by the time tucked in (A2-05). */
const bubble =
  "rounded-card rounded-ee-tag bg-[color-mix(in_srgb,var(--color-star)_13%,var(--color-card))] px-4 py-2.5 leading-[1.45] whitespace-pre-wrap text-text-strong";

/** Your words on the right, under who sent them and when. */
const yourColumn = "flex max-w-bubble-max animate-hb-in flex-col items-end gap-1 self-end";

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
 * steps, such as the approval cards its tool calls are waiting on, and `after` under its text, such
 * as what it saved to memory.
 */
export function MessageRow({
  message,
  hob,
  focused = false,
  resume,
  after,
  children,
}: {
  message: Message;
  hob: Agent;
  focused?: boolean;
  resume?: ContinueReply | undefined;
  after?: ReactNode;
  children?: ReactNode;
}) {
  const id = messageElementId(message.id);
  if (message.role === "user") {
    return (
      <div id={id} className={cn(yourColumn, focused && focusRing)}>
        <span className="text-meta text-label">{copy.you({ time: formatTime(message.createdAt) })}</span>
        <div className={bubble}>{message.content}</div>
      </div>
    );
  }

  return (
    <ReplyRow message={message} hob={hob} id={id} focused={focused} resume={resume} after={after}>
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
  after,
  children,
}: {
  message: Message;
  hob: Agent;
  id: string;
  focused: boolean;
  resume: ContinueReply | undefined;
  after: ReactNode;
  children: ReactNode;
}) {
  const streaming = isInProgress(message.status);
  const writing = message.status === "streaming";
  return (
    <article
      id={id}
      className={cn("flex animate-hb-in flex-col gap-2.5", focused && focusRing)}
      style={{ "--hob": HOB_COLORS[hob.lookColor].hat } as CSSProperties}
    >
      {/* The tile, the name, the role and the time; the reply sits under the name, past the tile. */}
      <span className="flex items-center gap-2.5">
        <HobTile hob={hob} tile="md" state={streaming ? "working" : message.status === "failed" ? "failed" : "idle"} />
        <b className="font-heading text-ui font-(--heading-weight) text-moonlight">{hob.name}</b>
        <span className="rounded-tag bg-[color-mix(in_srgb,var(--hob)_22%,transparent)] px-1.75 text-meta font-semibold text-text-strong">
          {copy.lead}
        </span>
        <span className="text-meta text-label">{writing ? copy.writing : formatTime(message.createdAt)}</span>
      </span>
      <div className="ms-10 flex min-w-0 flex-col gap-[3px]">
        <ReplySteps
          steps={message.steps}
          inProgress={streaming}
          logUrl={(stepId) => toolLogUrl(message.threadId, message.id, stepId)}
          settle={(stepId) => <SettleCharmCall threadId={message.threadId} messageId={message.id} stepId={stepId} />}
        />
        {children}
        {writing && message.content.length === 0 ? (
          message.steps.length === 0 && <Thinking name={hob.name} />
        ) : (
          <ReplyMarkdown content={message.content} streaming={streaming} caret={writing} />
        )}
        {after}
        {message.status === "stopping" && (
          <span role="status" className="flex items-center gap-2 text-detail text-lantern">
            <span aria-hidden className="size-[5px] animate-hb-blink rounded-dot bg-lantern" />
            {copy.stopping}
          </span>
        )}
        {message.status === "stopped" && (
          <span role="status" className="animate-hb-in text-detail text-lantern">
            {copy.stopped({ name: hob.name })}
          </span>
        )}
        {message.status === "interrupted" && (
          <span className="animate-hb-in text-detail text-rose">
            {message.error === null ? copy.interrupted({ name: hob.name }) : copy.cutOff({ error: message.error })}
          </span>
        )}
        {message.status === "limited" && <LimitedNote message={message} name={hob.name} />}
        {resume && <ResumeControls resume={resume} name={hob.name} />}
        {message.status === "failed" && (
          <span className="animate-hb-in text-detail text-rose">{copy.failed({ error: message.error })}</span>
        )}
      </div>
    </article>
  );
}

/** The provider whose limit ended a reply, in the user's words. */
const providerName = (message: Message) => (message.runtime === "codex" ? "Codex" : "Claude");

/** A reply the provider's limit stopped, and when it refills, from the same plan the Usage screen reads. */
function LimitedNote({ message, name }: { message: Message; name: string }) {
  const plans = usePlans();
  const plan = planOf(plans, message.runtime ?? "claude-code");
  return (
    <span role="status" className="animate-hb-in text-detail text-lantern">
      {copy.limited({ name, provider: providerName(message), refill: limitRefill(plan, message.resetsAt, new Date()) })}
    </span>
  );
}

/** Continue for a reply that ended early, and Continue with each other ready brain. */
function ResumeControls({ resume, name }: { resume: ContinueReply; name: string }) {
  return resume.pending ? (
    <span role="status" className="flex items-center gap-2 text-detail text-text-secondary">
      <span aria-hidden className="size-[5px] animate-hb-blink rounded-dot bg-mint" />
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
    <section aria-label={messages.queued.label} className={cn(yourColumn, "gap-1.5")}>
      <div className={cn(bubble, "opacity-80")}>{message.content}</div>
      <span className="text-meta text-label">
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

/**
 * A message waiting in this browser to reach the hub: your bubble, faded, with where it stands.
 * While Hobbots reconnects it goes out on its own; one the hub refused says so in rose and offers
 * Try again. Edit takes it back into the composer.
 */
export function WaitingRow({
  message,
  refused,
  live,
  sending,
  onEdit,
  onTryAgain,
}: {
  message: Pick<Message, "content">;
  refused: boolean;
  live: boolean;
  sending: boolean;
  onEdit: () => void;
  onTryAgain: () => void;
}) {
  const chat = messages.chat;
  return (
    <section aria-label={chat.waiting} className={cn(yourColumn, "gap-1.5")}>
      <div className={cn(bubble, "opacity-60")}>{message.content}</div>
      <span className={cn("text-detail leading-[18px]", refused ? "text-rose" : "text-label")}>
        {refused ? chat.waitingRefused : live ? chat.waitingSending : chat.waitingOffline}
      </span>
      <span className="flex items-center gap-2">
        {refused && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onTryAgain}
            className="text-text-strong underline underline-offset-3"
          >
            {chat.tryAgain}
          </Button>
        )}
        <Button variant="outline" size="xs" disabled={sending} onClick={onEdit}>
          {chat.edit}
        </Button>
      </span>
    </section>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <span role="status" className="flex items-center gap-2.5 text-ui text-text-secondary">
      {copy.thinking({ name })}
      <span aria-hidden className="flex gap-1">
        <span className="size-[5px] animate-hb-blink rounded-dot bg-mint" />
        <span className="size-[5px] animate-hb-blink rounded-dot bg-mint [animation-delay:.3s]" />
        <span className="size-[5px] animate-hb-blink rounded-dot bg-mint [animation-delay:.6s]" />
      </span>
    </span>
  );
}
