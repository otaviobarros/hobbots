import type { TaskTreeRead } from "@hobbots/api";
import type { AgentId, QuestId, TaskId } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { applyTaskEvent } from "./tasks.ts";

/** A control from the Quest tab (ADR 018, OR-006): what it acts on, and how it is sent. */
export type TaskControl =
  | { readonly kind: "cancel"; readonly taskId: TaskId }
  | { readonly kind: "cancelQuest"; readonly questId: QuestId }
  | { readonly kind: "retry"; readonly taskId: TaskId }
  | { readonly kind: "reassign"; readonly taskId: TaskId; readonly agentId: AgentId };

const send = (control: TaskControl): Promise<TaskTreeRead> => {
  switch (control.kind) {
    case "cancel":
      return call((c) => c.taskControls.cancel({ params: { taskId: control.taskId } }));
    case "cancelQuest":
      return call((c) => c.taskControls.cancelQuest({ params: { questId: control.questId } }));
    case "retry":
      return call((c) => c.taskControls.retry({ params: { taskId: control.taskId } }));
    case "reassign":
      return call((c) =>
        c.taskControls.reassign({ params: { taskId: control.taskId }, payload: { agentId: control.agentId } }),
      );
  }
};

/**
 * Sends a Cancel, Retry or Reassign. The hub answers once it recorded the change, and the tab shows
 * that at once; what each Task confirms afterwards, such as a cancelled session that stopped,
 * arrives on the event stream. Sending one again changes nothing more.
 */
export const useTaskControl = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    // What the hub recorded shows at once, before its events arrive (see `ControlRecorded`).
    onSuccess: (read) => applyTaskEvent(queryClient, { _tag: "ControlRecorded", tree: read.tree }),
  });
};
