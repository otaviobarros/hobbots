import type { AgentId, AttemptId, TaskId, ThreadId } from "@hobbots/domain";
import { useNavigate } from "@tanstack/react-router";
import type { WorkbenchTab } from "./workbench-model.ts";

/**
 * Where the Workbench is in the address (STD-REACT-002): `bench` is the Task it shows, `tab` the
 * tab other than Summary, `attempt` an Attempt other than the latest, and `chat` while its chat
 * drawer is open. Opened from the drawer, `task` keeps the drawer's Task, so going back reopens it.
 */
export interface WorkbenchSearch {
  readonly bench?: string | undefined;
  readonly tab?: WorkbenchTab | undefined;
  readonly attempt?: string | undefined;
  readonly chat?: "open" | undefined;
}

/** Opens a Task's Workbench in the chat's place. It always opens on Summary, on the latest Attempt. */
export const useOpenWorkbench = (hobId: AgentId, threadId: ThreadId) => {
  const navigate = useNavigate();
  return (taskId: TaskId, from: "chat" | "drawer" = "chat") =>
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId, threadId },
      search: from === "drawer" ? { task: taskId, bench: taskId } : { bench: taskId },
    });
};

/** Moves within an open Workbench: its tab and Attempt, and back to where it was opened from. */
export const useWorkbenchMoves = (hobId: AgentId, threadId: ThreadId) => {
  const navigate = useNavigate();
  const to = "/hobs/$hobId/threads/$threadId" as const;
  const from = to;
  const params = { hobId, threadId };
  return {
    // Moving between tabs or Attempts replaces the address, so Back in the browser leaves the Workbench.
    tab: (tab: WorkbenchTab) =>
      void navigate({
        from,
        to,
        params,
        search: (prev) => ({ ...prev, tab: tab === "summary" ? undefined : tab }),
        replace: true,
      }),
    attempt: (attemptId: AttemptId) =>
      void navigate({ from, to, params, search: (prev) => ({ ...prev, attempt: attemptId }), replace: true }),
    chat: (open: boolean) =>
      void navigate({
        from,
        to,
        params,
        search: (prev) => ({ ...prev, chat: open ? "open" : undefined }),
        replace: true,
      }),
    back: () =>
      void navigate({
        from,
        to,
        params,
        search: (prev) => ({ task: prev.task }),
      }),
  };
};

/** The Workbench the address asks for. */
export interface WorkbenchView {
  readonly taskId: TaskId;
  readonly tab: WorkbenchTab;
  readonly attemptId: AttemptId | undefined;
  /** Where it was opened from, which Back returns to. */
  readonly from: "chat" | "drawer";
  /** Whether the Task's chat drawer is open beside the tabs. */
  readonly chatOpen: boolean;
}
