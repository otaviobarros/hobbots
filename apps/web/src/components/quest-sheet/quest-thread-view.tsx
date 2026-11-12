import type { AgentId, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { messagesQuery, useSendPrompt } from "../../api/queries.ts";
import { formatTime } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { enterSends } from "../quest/enter-sends.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { useSteerReceipts } from "../steer-receipt/steer-receipt.tsx";
import { messages } from "./messages.ts";
import { type QuestEntry, questThread } from "./quest-thread.ts";

const copy = messages.sheet;

/**
 * The quest's thread (ADR 037): what you and the lead said while it ran, the notes the lead gave its
 * party and what each member delivered, oldest first, with the box to message the lead about it. A
 * message you send goes to the lead in this chat, as one from the chat's own box does, and its steer
 * receipt under it shows whom the lead passed it to (ADR 027).
 */
export function QuestThreadView({
  tree,
  threadId,
  lead,
  hobs,
}: {
  tree: TaskTree;
  threadId: ThreadId;
  lead: AgentId;
  hobs: HobLookup;
}) {
  // The quest's own thread: the chat or camp it belongs to, which a pinned quest from elsewhere names.
  const home = tree.tasks[0]?.threadId ?? threadId;
  const transcript = useQuery(messagesQuery(home)).data ?? [];
  const receipts = useSteerReceipts(lead, home, transcript);
  const entries = questThread(tree, transcript);
  return (
    <section aria-label={copy.thread} className="flex flex-col gap-3">
      <h3 className="m-0 text-meta font-semibold text-label">{copy.thread}</h3>
      {entries.length === 0 && <p className="m-0 text-ui text-label">{copy.nothingYet}</p>}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {entries.map((entry) => (
          <li key={entry.key}>
            <Entry entry={entry} hobs={hobs} receipt={entry.kind === "yours" ? receipts.of(entry.message) : null} />
          </li>
        ))}
      </ol>
      {home === threadId && <QuestComposer threadId={threadId} leadName={hobs(lead).name} />}
    </section>
  );
}

/** Who said it and when, over what was said. */
function Said({
  who,
  at,
  kind,
  children,
}: {
  who: ReactNode;
  at: string;
  kind?: string | undefined;
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-1.5 text-ui">
      <span className="flex items-center gap-1.5 font-semibold text-text-strong">
        {who}
        <span className="font-normal text-meta text-label">
          {formatTime(at)}
          {kind !== undefined && ` · ${kind}`}
        </span>
      </span>
      <div className="ps-7 whitespace-pre-wrap text-text-strong">{children}</div>
    </article>
  );
}

function Hob({ id, hobs, after }: { id: AgentId; hobs: HobLookup; after?: string }) {
  const hob = hobs(id);
  return (
    <>
      <HobSprite hob={hob} size={20} />
      <span>{hob.name}</span>
      {after !== undefined && <span className="font-normal text-label">{after}</span>}
    </>
  );
}

function Entry({ entry, hobs, receipt }: { entry: QuestEntry; hobs: HobLookup; receipt: ReactNode }) {
  switch (entry.kind) {
    case "yours":
      return (
        <div className="flex flex-col gap-1.5">
          <Said who={<span className="ps-7">{copy.you}</span>} at={entry.at}>
            <span className="line-clamp-6">{entry.message.content}</span>
          </Said>
          {receipt}
        </div>
      );
    case "lead":
      return (
        <Said who={<Hob id={entry.hob} hobs={hobs} />} at={entry.at}>
          <span className="line-clamp-6">{entry.message.content}</span>
        </Said>
      );
    case "note":
      return (
        <Said
          who={<Hob id={entry.from} hobs={hobs} after={copy.passedTo({ name: hobs(entry.to).name })} />}
          at={entry.at}
        >
          <span className="line-clamp-4">{entry.text}</span>
        </Said>
      );
    case "done":
      return (
        <Said who={<Hob id={entry.task.ownerId} hobs={hobs} />} at={entry.at} kind={copy.delivered}>
          <span className="line-clamp-4">{entry.text}</span>
        </Said>
      );
    case "failed":
      return (
        <Said who={<Hob id={entry.task.ownerId} hobs={hobs} />} at={entry.at} kind={copy.failed}>
          <span className="line-clamp-2 text-rose">{taskTitle(entry.task)}</span>
        </Said>
      );
  }
}

/** The box at the thread's end: a message to the lead about the quest, sent to the chat it belongs to. */
function QuestComposer({ threadId, leadName }: { threadId: ThreadId; leadName: string }) {
  const [text, setText] = useState("");
  const send = useSendPrompt(threadId);
  const submit = () => {
    const content = text.trim();
    if (content === "" || send.isPending) return;
    send.mutate(content, { onSuccess: () => setText("") });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const label = copy.compose({ name: leadName });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1.5">
      <span className="flex items-end gap-2">
        <Textarea
          aria-label={label}
          placeholder={label}
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={enterSends(submit)}
          className="min-h-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={text.trim() === "" || send.isPending}>
          {send.isPending ? copy.sending : copy.send}
        </Button>
      </span>
      <span className="text-meta text-label">{copy.composeHint}</span>
      {send.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.sendFailed}
        </p>
      )}
    </form>
  );
}
