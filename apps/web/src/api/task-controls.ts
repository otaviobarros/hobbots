import type { TaskTreeRead } from "@hobbots/api";
import type { AgentId, QuestId, TaskId, TaskTree } from "@hobbots/domain";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { applyTaskEvent } from "./tasks.ts";

/**
 * Puts what the hub recorded for a control into every cached Task read at once, before its events
 * arrive. Each Task goes in as the change the stream would bring, so a newer copy already known is
 * kept and the events that follow change nothing twice.
 */
const applyControlledTree = (client: QueryClient, tree: TaskTree) => {
  for (const task of tree.tasks) {
    applyTaskEvent(client, {
      _tag: "TaskStateChanged",
      task,
      attempt: tree.attempts.find((each) => each.id === task.currentAttemptId) ?? null,
      quest: tree.quests.find((each) => each.taskId === task.id) ?? null,
      wait: tree.waits.find((each) => each.taskId === task.id) ?? null,
    });
  }
};

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
    onSuccess: (read) => applyControlledTree(queryClient, read.tree),
  });
};
