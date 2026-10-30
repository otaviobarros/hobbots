import type { AgentId, ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { threadsQuery } from "../api/queries.ts";
import { readStored, writeStored } from "../lib/storage.ts";
import { ChatView } from "./chat-view.tsx";
import { HobList } from "./hob-list.tsx";
import { SidePanel } from "./side-panel.tsx";

const usePersistentToggle = (key: string) => {
  const [open, setOpen] = useState(() => readStored(key, true));
  const set = (value: boolean) => {
    writeStored(key, value);
    setOpen(value);
  };
  return [open, set] as const;
};

/** The chat workspace: hob list, chat, and the Quest panel. Both side panels collapse. */
export function HobsLayout({
  hobId,
  threadId,
  focusMessageId,
}: {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  /** A message to scroll to and mark, such as a search match. */
  focusMessageId?: string | undefined;
}) {
  const [navOpen, setNavOpen] = usePersistentToggle("layout.navOpen");
  const [panelOpen, setPanelOpen] = usePersistentToggle("layout.panelOpen");
  useThreadKeys(hobId, threadId);

  return (
    <div className="flex min-w-0 flex-1">
      {navOpen && <HobList hobId={hobId} threadId={threadId} onHide={() => setNavOpen(false)} />}
      <ChatView
        key={threadId ?? `new-${hobId}`}
        hobId={hobId}
        threadId={threadId}
        focusMessageId={focusMessageId}
        navOpen={navOpen}
        panelOpen={panelOpen}
        onShowNav={() => setNavOpen(true)}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
      />
      {panelOpen && <SidePanel hobId={hobId} threadId={threadId} />}
    </div>
  );
}

/** ⌥↑ and ⌥↓ move between the current hob's threads. */
const useThreadKeys = (hobId: AgentId, threadId: ThreadId | undefined) => {
  const threads = useQuery(threadsQuery(hobId));
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const list = threads.data ?? [];
      if (list.length === 0) return;
      const index = list.findIndex((t) => t.id === threadId);
      const step = event.key === "ArrowUp" ? -1 : 1;
      const target = list[index === -1 ? 0 : (index + step + list.length) % list.length];
      if (!target) return;
      event.preventDefault();
      void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId: target.id } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [threads.data, threadId, hobId, navigate]);
};
