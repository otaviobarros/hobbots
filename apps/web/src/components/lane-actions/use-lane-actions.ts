import type { Agent, TaskId } from "@hobbots/domain";
import { useState } from "react";
import { type TaskControl, useTaskControl } from "../../api/task-controls.ts";

/**
 * Which view the lane's ⋯ menu shows: its items, the hobs Reassign… can give the Task to, or which
 * of the hob's Tasks Cancel task… stops when it has more than one open.
 */
export type MenuView = "items" | "reassign" | "cancel";

/**
 * What the room's lanes share while you act in them (ADR 027): the one ⋯ menu that is open and its
 * view, the one cancel waiting for Yes, and the one control on its way to the hub. The room holds it
 * whether or not its Task tree has loaded. A lane's menu and
 * the cards in its body read the same state, so Reassign… on a failed Task opens its menu on the
 * hobs, and a refusal shows in the lane whose Task the hub refused.
 */
export const useLaneActions = () => {
  const control = useTaskControl();
  const [menu, setMenu] = useState<{ readonly taskId: TaskId; readonly view: MenuView } | null>(null);
  const [asking, setAsking] = useState<TaskId | null>(null);
  // The lane Task the last control was sent from, and the hob a Reassign picked.
  const [sent, setSent] = useState<{ readonly taskId: TaskId; readonly target: Agent | null } | null>(null);
  const on = (taskId: TaskId) => sent?.taskId === taskId;
  return {
    /** The view of the Task's menu while it is open, else null. */
    menuOf: (taskId: TaskId): MenuView | null => (menu?.taskId === taskId ? menu.view : null),
    openMenu: (taskId: TaskId, view: MenuView = "items") => {
      control.reset();
      setMenu({ taskId, view });
    },
    closeMenu: () => setMenu(null),
    /** Whether the Task's cancel waits for Yes. */
    asking: (taskId: TaskId) => asking === taskId,
    ask: (taskId: TaskId | null) => {
      control.reset();
      setAsking(taskId);
    },
    /**
     * Sends a control for a lane's Task, with the hob a Reassign picked; once the hub recorded it,
     * its question and menu close.
     */
    send: (taskId: TaskId, next: TaskControl, target: Agent | null = null) => {
      setSent({ taskId, target });
      control.mutate(next, {
        onSuccess: () => {
          setAsking(null);
          setMenu(null);
        },
      });
    },
    /** Any control is on its way, so none can be sent twice. */
    busy: control.isPending,
    /** The kind of control on its way for the Task, else null. */
    sending: (taskId: TaskId): TaskControl["kind"] | null =>
      control.isPending && on(taskId) ? (control.variables?.kind ?? null) : null,
    /** Why the hub refused the Task's last control, with the hob a Reassign picked; null when it did not. */
    refusal: (taskId: TaskId): { readonly error: unknown; readonly target: Agent | null } | null =>
      control.isError && on(taskId) ? { error: control.error, target: sent?.target ?? null } : null,
  };
};

export type LaneActions = ReturnType<typeof useLaneActions>;
