import type { Agent, AgentId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { archivedAgentsQuery, messagesQuery, threadsQuery } from "../api/queries.ts";
import { formatDay, formatWhen } from "../lib/time.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { MessageRow } from "./message-row.tsx";

const retiredLabel = (hob: Agent) => (hob.retiredAt ? `retired ${formatDay(hob.retiredAt)}` : "retired");

const chatsLabel = (count: number) => (count === 1 ? "1 chat kept" : `${count} chats kept`);

/** Settings › Archived hobs: every retired hob, asleep, with its chats one click away (AG-006). */
export function ArchivedHobs() {
  const hobs = useQuery(archivedAgentsQuery);
  if (hobs.isError) {
    return <p className="m-0 text-sm text-rose">Hobbots could not read your archived hobs. Try again in a moment.</p>;
  }
  if (!hobs.data) return <p className="m-0 text-sm text-label">Loading archived hobs…</p>;
  return (
    <>
      <p className="m-0 text-secondary-text">
        Hobs you retired. They are asleep: they take no new work, and their chats stay here to read.
      </p>
      {hobs.data.length === 0 ? (
        <p className="m-0 text-sm text-secondary-text">No retired hobs.</p>
      ) : (
        <ul aria-label="Archived hobs" className="m-0 flex list-none flex-col p-0">
          {hobs.data.map((hob) => (
            <ArchivedHobRow key={hob.id} hob={hob} />
          ))}
        </ul>
      )}
      <p className="m-0 text-[13px] text-label">To retire a hob, open its profile and choose Retire.</p>
    </>
  );
}

function ArchivedHobRow({ hob }: { hob: Agent }) {
  const threads = useQuery(threadsQuery(hob.id));
  const meta = [hob.craft, retiredLabel(hob), threads.data && chatsLabel(threads.data.length)].filter(Boolean);
  return (
    <li className="flex items-center gap-4 border-b-2 border-line py-3.5">
      <HobSprite hob={hob} size={40} state="asleep" className="grayscale-60 brightness-80" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-pixel text-[17px] font-bold">{hob.name}</span>
        <span className="text-[13px] text-secondary-text">{meta.join(" · ")}</span>
      </div>
      <Button asChild variant="outline" size="xs">
        <Link to="/settings/archived/$hobId" params={{ hobId: hob.id }} aria-label={`Read ${hob.name}'s chats`}>
          Read chats
        </Link>
      </Button>
    </li>
  );
}

/**
 * A retired hob's threads, read-only: the thread list and the chosen thread, with no composer.
 * Without a thread id it shows that the hob left no chats.
 */
export function ArchivedHobView({ hobId, threadId }: { hobId: AgentId; threadId?: ThreadId | undefined }) {
  const hobs = useQuery(archivedAgentsQuery);
  const threads = useQuery(threadsQuery(hobId));
  const hob = hobs.data?.find((h) => h.id === hobId);

  if (hobs.data && !hob) return <ArchivedNotice>This hob is not in Archived hobs.</ArchivedNotice>;
  if (hobs.isError || threads.isError) {
    return <ArchivedNotice>Hobbots could not read this hob's chats. Try again in a moment.</ArchivedNotice>;
  }
  if (!hob || !threads.data) return <ArchivedNotice>Loading chats…</ArchivedNotice>;
  const thread = threads.data.find((t) => t.id === threadId);

  return (
    <div className="flex min-w-0 flex-1">
      <nav
        aria-label={`${hob.name}'s chats`}
        className="flex w-64 flex-none flex-col gap-2.5 border-r-4 border-line bg-panel px-2.5 py-3"
      >
        <Link to="/settings/archived" className="px-2 text-sm text-lantern no-underline hover:underline">
          ‹ Archived hobs
        </Link>
        <div className="flex items-center gap-2.5 px-2 py-[7px]">
          <span className="bg-line p-0.5">
            <HobSprite hob={hob} size={28} state="asleep" className="grayscale-60 brightness-80" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-pixel text-base font-semibold">{hob.name}</span>
            <span className="text-xs text-label">
              {hob.craft} · {retiredLabel(hob)}
            </span>
          </span>
        </div>
        <div className="flex min-h-0 flex-col gap-px overflow-y-auto">
          {threads.data.map((thread) => (
            <Link
              key={thread.id}
              to="/settings/archived/$hobId/threads/$threadId"
              params={{ hobId, threadId: thread.id }}
              aria-current={thread.id === threadId ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2 py-[7px] pr-2.5 pl-[34px] text-sm text-text no-underline hover:bg-hover hover:text-text",
                thread.id === threadId && "bg-line text-moonlight hover:text-moonlight",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="text-[11px] whitespace-nowrap text-label">{formatWhen(thread.updatedAt)}</span>
            </Link>
          ))}
        </div>
      </nav>
      {thread ? (
        <ArchivedThread hob={hob} threadId={thread.id} title={thread.title} />
      ) : threadId ? (
        // Messages load by thread id alone, so another hob's thread must not show under this hob.
        <ArchivedNotice>This chat is not one of {hob.name}'s.</ArchivedNotice>
      ) : (
        <ArchivedNotice>{hob.name} left no chats.</ArchivedNotice>
      )}
    </div>
  );
}

function ArchivedThread({ hob, threadId, title }: { hob: Agent; threadId: ThreadId; title: string }) {
  const messages = useQuery(messagesQuery(threadId));
  const top = useRef<HTMLDivElement>(null);
  // A different thread starts at its beginning, as a transcript is read from the top.
  useEffect(() => {
    if (threadId) top.current?.scrollIntoView({ block: "start" });
  }, [threadId]);

  return (
    <main aria-label="Chat" className="flex min-w-[360px] flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b-4 border-line px-4 py-2.5">
        <HobSprite hob={hob} size={36} state="asleep" className="grayscale-60 brightness-80" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-pixel text-xl font-semibold whitespace-nowrap">{hob.name}</span>
            <span className="truncate text-secondary-text">{title}</span>
          </span>
          <span className="text-xs text-label">
            {hob.craft} · {retiredLabel(hob)}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-[18px]">
        <div ref={top} />
        {messages.isPending && <p className="text-label">Loading messages…</p>}
        {messages.isError && <p className="text-sm text-rose">Hobbots could not read this chat. Try again.</p>}
        {messages.data?.map((message) => (
          <MessageRow key={message.id} message={message} hob={hob} />
        ))}
      </div>

      <p role="note" className="m-0 flex-none border-t-4 border-line px-6 py-3.5 text-sm text-secondary-text">
        {hob.name} is retired, so this chat is read-only.
      </p>
    </main>
  );
}

function ArchivedNotice({ children }: { children: React.ReactNode }) {
  return <section className="grid flex-1 place-items-center text-label">{children}</section>;
}
