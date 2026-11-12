import type { AgentId, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { messagesQuery } from "../../api/queries.ts";
import { formatTime } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { HubWait } from "../loading/hub-wait.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { useSteerReceipts } from "../steer-receipt/steer-receipt.tsx";
import { messages } from "./messages.ts";
import { QuestComposer } from "./quest-composer.tsx";
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
  const top = tree.tasks[0];
  const home = top?.threadId ?? threadId;
  const read = useQuery(messagesQuery(home));
  const transcript = read.data ?? [];
  const receipts = useSteerReceipts(lead, home, transcript);
  const entries = questThread(tree, transcript);
  // Until the chat is read, the thread says it waits or why it could not, never that nothing was said.
  const empty = entries.length === 0 && read.isSuccess;
  return (
    <section aria-label={copy.thread} className="flex flex-col gap-3">
      <h3 className="m-0 text-meta font-semibold text-label">{copy.thread}</h3>
      {empty && <p className="m-0 text-ui text-label">{copy.nothingYet}</p>}
      {read.isPending && <HubWait pending onRetry={() => void read.refetch()} />}
      {read.isError && (
        <p role="alert" className="m-0 flex items-center gap-2 text-detail text-rose">
          {copy.threadUnread}
          <Button variant="ghost" size="xs" onClick={() => void read.refetch()}>
            {messages.tryAgain}
          </Button>
        </p>
      )}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {entries.map((entry) => (
          <li key={entry.key}>
            <Entry entry={entry} hobs={hobs} receipt={entry.kind === "yours" ? receipts.of(entry.message) : null} />
          </li>
        ))}
      </ol>
      {home === threadId && top !== undefined && (
        <QuestComposer threadId={threadId} questId={top.id} leadName={hobs(lead).name} />
      )}
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
