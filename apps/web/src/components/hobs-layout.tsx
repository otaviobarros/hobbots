import type { AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { threadsQuery } from "../api/queries.ts";
import { readStored, writeStored } from "../lib/storage.ts";
import { ArchiveProvider } from "./archive/archive-context.tsx";
import { ThreadMain, type WorkspaceMainProps } from "./archived-threads/archived-threads.tsx";
import { HobList } from "./hob-list.tsx";
import { useNoteDrafts } from "./quest/note-box.tsx";
import { usePins } from "./quest/use-work.ts";
import { WorkSheet } from "./work-sheet/work-sheet.tsx";
import type { WorkbenchView } from "./workbench/use-workbench.ts";
import { Workbench } from "./workbench/workbench.tsx";

const usePersistentToggle = (key: string) => {
  const [open, setOpen] = useState(() => readStored(key, true));
  const set = (value: boolean) => {
    writeStored(key, value);
    setOpen(value);
  };
  return [open, set] as const;
};

interface WorkspaceProps {
  hobId: AgentId;
  threadId?: ThreadId | undefined;
  /** A message to scroll to and mark, such as a search match. */
  focusMessageId?: string | undefined;
  /** A Task to show in the work sheet over the chat. */
  taskId?: TaskId | undefined;
  /** A request's Quest, by its top Task, to show in the work sheet. */
  questId?: TaskId | undefined;
  main?: ((props: WorkspaceMainProps) => ReactNode) | undefined;
  /** A Task's Workbench to show in the chat's place (ADR 023). */
  workbench?: WorkbenchView | undefined;
  /** What sits at the end, such as a hob page's side column. */
  aside?: ReactNode | null;
}

/**
 * The chat workspace: hob list and its middle, where the work sheet and the Workbench open over the
 * chat. The middle is the thread's chat unless the route fills it with `main`, such as the hob's
 * archived threads. Threads are archived from their menus or with ⌃⌘A, with Undo in a toast.
 */
export function HobsLayout(props: WorkspaceProps) {
  return (
    <ArchiveProvider hobId={props.hobId} threadId={props.threadId}>
      <Workspace {...props} />
    </ArchiveProvider>
  );
}

function Workspace({
  hobId,
  threadId,
  focusMessageId,
  taskId,
  questId,
  main = (props) => <ThreadMain {...props} />,
  workbench,
  aside,
}: WorkspaceProps) {
  const [navOpen, setNavOpen] = usePersistentToggle("layout.navOpen");
  // Pinned Quests show in every thread's header and open in its sheet.
  const pins = usePins();
  // The drawer and the Workbench show the same unsent note for a Task, and both outlive each other.
  const drafts = useNoteDrafts();
  useThreadKeys(hobId, threadId);
  const benchOpen = threadId !== undefined && workbench !== undefined;

  return (
    <div className="flex min-w-0 flex-1">
      {navOpen && <HobList hobId={hobId} threadId={threadId} onHide={() => setNavOpen(false)} />}
      <div className="relative flex min-w-0 flex-1">
        {/* The Workbench covers the chat without unmounting it, so going back finds the same scroll
            position and unsent message; meanwhile the chat is hidden from sight and focus. */}
        <div className={cn("flex min-w-0 flex-1", benchOpen && "invisible")} inert={benchOpen}>
          {main({
            hobId,
            threadId,
            focusMessageId,
            navOpen,
            onShowNav: () => setNavOpen(true),
            pins,
          })}
        </div>
        {/* The sheet closes while the Workbench covers the chat; Back to the task opens it again. */}
        {threadId !== undefined && !benchOpen && (
          <WorkSheet
            key={threadId}
            hobId={hobId}
            threadId={threadId}
            questId={questId}
            taskId={taskId}
            pins={pins}
            drafts={drafts}
          />
        )}
        {threadId !== undefined && workbench !== undefined && (
          <Workbench hobId={hobId} threadId={threadId} view={workbench} pinned={pins.pinned} drafts={drafts} />
        )}
      </div>
      {aside}
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
