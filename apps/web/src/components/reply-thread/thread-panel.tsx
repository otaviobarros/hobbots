import { type Agent, type Channel, ChannelLifecycle, type Message, MessageId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useState } from "react";
import { sidebarQuery } from "../../api/sidebar.ts";
import { useReplyInThread } from "../../api/threads.ts";
import { repliesIn } from "../../lib/reply-threads.ts";
import { formatTime } from "../../lib/time.ts";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { FaceTile } from "../sidebar/sidebar-faces.tsx";
import { messages as copy } from "./messages.ts";
import { type Cast, whoIs } from "./thread-faces.ts";
import type { OpenThread } from "./use-thread.ts";

/** The hobs and people a thread names its authors from: every hob, and you and the people the sidebar knows. */
export const useCast = (hobs: ReadonlyArray<Agent> | undefined): Cast => {
  const read = useQuery({ ...sidebarQuery, select: (data) => ({ you: data.you, people: data.people }) }).data;
  return { hobs: hobs ?? [], you: read?.you, people: read?.people ?? [] };
};

/**
 * The reply thread open beside the chat (ADR 039, Reply threads): its root, then its replies, and a
 * box to reply in, with Also send to the camp. It sits beside the transcript, not over it, and gives
 * the chat back its width when closed. No hob answers in a thread yet (#1485), which the box says.
 */
export function ThreadPanel({
  channel,
  messages,
  cast,
  thread,
}: {
  channel: Channel | undefined;
  messages: ReadonlyArray<Message> | undefined;
  cast: Cast;
  thread: OpenThread;
}) {
  if (thread.open === undefined || channel === undefined) return null;
  const root = messages?.find((message) => message.id === thread.open);
  const replies = messages === undefined ? [] : repliesIn(messages, thread.open);
  return (
    <aside
      aria-label={copy.landmark}
      className="flex w-thread min-w-0 flex-none animate-hb-in flex-col border-s border-line bg-panel @max-[760px]/chat:absolute @max-[760px]/chat:inset-0 @max-[760px]/chat:z-10 @max-[760px]/chat:w-auto"
    >
      <header className="flex items-center gap-2 ps-[18px] pe-3.5 pt-3.5 pb-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 font-heading text-[18px] leading-6 font-(--heading-weight) text-text-strong">
            {copy.title}
          </h2>
          <small className="truncate text-meta text-label">{channel.title}</small>
        </span>
        <Button variant="ghost" size="icon" aria-label={copy.close} title={copy.close} onClick={thread.close}>
          <span aria-hidden>✕</span>
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pt-3 pb-4 wrap-anywhere">
        {root === undefined ? (
          messages !== undefined && <p className="m-0 text-ui text-text-secondary">{copy.gone}</p>
        ) : (
          <>
            <ThreadMessage message={root} cast={cast} />
            <div className="flex items-center gap-2.5 text-meta font-semibold text-label after:h-px after:flex-1 after:bg-line">
              {replies.length === 0 ? copy.noReplies : copy.replies({ count: replies.length })}
            </div>
            {replies.map((reply) => (
              <ThreadMessage key={reply.id} message={reply} cast={cast} channel={channel} />
            ))}
          </>
        )}
      </div>
      {root !== undefined && ChannelLifecycle.isOpen(channel) && (
        <ThreadComposer key={root.id} channel={channel} rootId={root.id} />
      )}
    </aside>
  );
}

/** One message of the thread: who wrote it and when, then its text; a reply also sent says where. */
function ThreadMessage({ message, cast, channel }: { message: Message; cast: Cast; channel?: Channel }) {
  const who = whoIs(cast, message.actor);
  return (
    <article className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-2.5">
      <span aria-hidden className="inline-flex">
        {who.face !== null && <FaceTile face={who.face} size="md" />}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-baseline gap-1.5">
          <b className="text-ui font-bold text-text-strong">{who.name}</b>
          <span className="text-meta text-label">{formatTime(message.createdAt)}</span>
        </span>
        {message.role === "assistant" ? (
          <ReplyMarkdown content={message.content} streaming={false} caret={false} />
        ) : (
          <p className="m-0 text-ui whitespace-pre-wrap text-text">{message.content}</p>
        )}
        {channel !== undefined && message.alsoInMainLine && (
          <span className="text-meta text-label">
            {channel.kind === "camp" ? copy.alsoSent.camp({ title: channel.title }) : copy.alsoSent.chat}
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * The box under a thread: your reply, Also send to the camp, and Send. A reply keeps its key until it
 * is written, so sending again after a lost answer writes it once; a refused one keeps its text.
 */
function ThreadComposer({ channel, rootId }: { channel: Channel; rootId: MessageId }) {
  const send = useReplyInThread(channel.id, rootId);
  const [draft, setDraft] = useState("");
  const [also, setAlso] = useState(false);
  const [key, setKey] = useState(() => MessageId.make(crypto.randomUUID()));
  const content = draft.trim();
  const submit = () => {
    if (content.length === 0 || send.isPending) return;
    send.mutate(
      { key, content, alsoInMainLine: also },
      {
        onSuccess: () => {
          setDraft("");
          setAlso(false);
          setKey(MessageId.make(crypto.randomUUID()));
        },
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <div className="flex flex-col gap-1.5 border-t border-line px-[18px] pt-3 pb-3.5">
      <div className="flex flex-col gap-2 rounded-card border-(length:--edge) border-control bg-card px-3 py-2.5">
        <Textarea
          variant="bare"
          rows={2}
          className="min-h-0"
          aria-label={copy.placeholder}
          placeholder={copy.placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-meta whitespace-nowrap text-text-secondary">
            <input
              type="checkbox"
              className="size-4 accent-focus-ring"
              checked={also}
              onChange={(event) => setAlso(event.target.checked)}
            />
            {channel.kind === "camp" ? copy.alsoSend.camp : copy.alsoSend.chat}
          </label>
          <span className="flex-1" />
          <span className="text-meta font-semibold text-label">{copy.noHobAnswers}</span>
          <Button size="xs" disabled={content.length === 0 || send.isPending} onClick={submit}>
            {send.isPending ? copy.sending : copy.send}
          </Button>
        </div>
      </div>
      {send.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.failed}
        </p>
      )}
    </div>
  );
}
