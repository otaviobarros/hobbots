import { type AgentId, isInProgress, type ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useActivity } from "../api/activity.ts";
import {
  agentsQuery,
  messagesQuery,
  threadsQuery,
  useInterrupt,
  usePauseHob,
  useSendPrompt,
  useStartThread,
} from "../api/queries.ts";
import { sendErrorText } from "../lib/send-error.ts";
import { Composer } from "./composer.tsx";
import { HobSprite, stateLabel, threadState } from "./hob-sprite.tsx";
import { MessageRow } from "./message-row.tsx";
import { RuntimeChip } from "./runtime.tsx";

const IDEAS = ["Summarize an article I paste", "Help me plan my week", "Explain a concept simply"];

/** The middle of the chat workspace. Without a thread id it is the empty "fresh page". */
export function ChatView({
  hobId,
  threadId,
  navOpen,
  panelOpen,
  onShowNav,
  onTogglePanel,
}: {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  navOpen: boolean;
  panelOpen: boolean;
  onShowNav: () => void;
  onTogglePanel: () => void;
}) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  const thread = useQuery({
    ...threadsQuery(hobId),
    select: (threads) => threads.find((t) => t.id === threadId),
  });
  const threadCount = useQuery({ ...threadsQuery(hobId), select: (threads) => threads.length });
  const messages = useQuery({ ...messagesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  const activity = useActivity();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const send = useSendPrompt(threadId ?? ("" as ThreadId));
  const start = useStartThread(hobId);
  const interrupt = useInterrupt(threadId ?? ("" as ThreadId));
  const pause = usePauseHob(hobId);

  const streaming = messages.data?.some((m) => isInProgress(m.status)) ?? false;
  // Stopping lasts from the hub recording the request until the runtime confirms the turn ended.
  const stopping = interrupt.isPending || (messages.data?.some((m) => m.status === "stopping") ?? false);
  const busy = streaming || send.isPending;
  const lastContent = messages.data?.at(-1)?.content;

  useEffect(() => {
    if (lastContent !== undefined) bottom.current?.scrollIntoView({ block: "end" });
  }, [lastContent]);

  const current = hob.data;
  if (!current) return <main className="flex-1" />;

  const state = threadState(current, threadId ? activity[threadId] : undefined, streaming);
  const paused = current.status === "paused";
  const title = thread.data?.title ?? "New thread";
  const sendDraft = (content: string) => {
    if (threadId) {
      send.mutate(content, { onSuccess: () => setDraft("") });
      return;
    }
    start.mutate(content, {
      onSuccess: ({ thread: created }) => {
        setDraft("");
        void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId: created.id } });
      },
    });
  };
  const error = send.error ?? start.error;
  // Waking clears a send the paused hob refused, so the draft can simply be sent again.
  const wake = () =>
    pause.mutate(false, {
      onSuccess: () => {
        send.reset();
        start.reset();
      },
    });
  // A hob with no threads yet has just arrived, so its first page says hello.
  const newHob = threadId === undefined && threadCount.data === 0;
  const empty = threadId === undefined || messages.data?.length === 0;

  return (
    <main aria-label="Chat" className="flex min-w-[360px] flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b-4 border-line px-4 py-2.5">
        {!navOpen && (
          <Button variant="icon" size="icon" onClick={onShowNav} aria-label="Show hob list" title="Show hob list">
            »
          </Button>
        )}
        <HobSprite hob={current} size={36} state={state} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-pixel text-xl font-semibold whitespace-nowrap">{current.name}</span>
            <span className="truncate text-secondary-text">{title}</span>
          </span>
          <span className="text-xs text-label">
            {current.roleTitle} · {stateLabel[state]}
          </span>
        </div>
        <RuntimeChip />
        <Button asChild variant="outline">
          <Link to="/hobs/$hobId/profile" params={{ hobId }}>
            Edit hob
          </Link>
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onTogglePanel}
          aria-label={panelOpen ? "Hide Quest panel" : "Show Quest panel"}
          title={panelOpen ? "Hide Quest panel" : "Show Quest panel"}
        >
          {panelOpen ? "»" : "«"}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-[18px]">
        {threadId && messages.isPending && <p className="text-label">Loading messages…</p>}
        {empty && !messages.isLoading && (
          <div className="m-auto flex max-w-[420px] animate-hb-in flex-col items-center gap-3 text-center">
            <HobSprite hob={current} size={72} state="working" />
            <span className="font-pixel text-[22px] font-bold text-moonlight">
              {newHob ? `Hello, I'm ${current.name}!` : "A fresh page"}
            </span>
            <span className="text-secondary-text">
              {newHob
                ? "Tell me my first chore. I keep working even if you switch to another thread."
                : `Tell ${current.name} what you need. It keeps working even if you switch to another thread.`}
            </span>
            <div className="flex flex-wrap justify-center gap-1.5">
              {IDEAS.map((idea) => (
                <Button key={idea} variant="chip" onClick={() => setDraft(idea)}>
                  {idea}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.data?.map((message) => (
          <MessageRow key={message.id} message={message} hob={current} />
        ))}
        {error && (
          <p role="alert" className="text-sm text-rose">
            {sendErrorText(error, current)}
          </p>
        )}
        {pause.isError && (
          <p role="alert" className="text-sm text-rose">
            Hobbots could not wake {current.name}. Try again.
          </p>
        )}
        <div ref={bottom} />
      </div>

      <Composer
        placeholder={`Message ${current.name} in “${title}”…`}
        draft={draft}
        onDraft={setDraft}
        busy={busy}
        stopping={stopping}
        sending={start.isPending}
        onSend={sendDraft}
        onStop={() => interrupt.mutate()}
        paused={paused ? { name: current.name, waking: pause.isPending, onWake: wake } : undefined}
      />
    </main>
  );
}
