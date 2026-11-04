import type { AgentId, AttemptId, TaskId, ThreadId } from "@hobbots/domain";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { searchParam } from "../../lib/search-params.ts";
import { WorkbenchTab } from "../workbench/workbench-model.ts";

/**
 * Where the Quest room is in a thread's address (ADR 027, STD-REACT-002): `room` names a Task of the
 * Quest to open, `lane` the Task whose lane is lit, `tab` the Workbench tab while the dock is open,
 * `attempt` a try other than the one the Workbench picks and `file` a file the tab shows first. A
 * link that names a Task other than the Quest's top one lights that Task's lane.
 */
export const RoomSearch = {
  room: searchParam(Schema.String),
  lane: searchParam(Schema.String),
  tab: searchParam(WorkbenchTab),
  attempt: searchParam(Schema.String),
  file: searchParam(Schema.String),
};

/** The room the address asks for. */
export interface RoomView {
  /** A Task of the Quest: its top Task, or the one a link named. */
  readonly taskId: TaskId;
  readonly lane: TaskId | undefined;
  /** The Workbench tab while the dock is open; undefined while it is folded. */
  readonly tab: WorkbenchTab | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly file: string | undefined;
}

/** What a link puts in the address to open the room on a Task, with its lane lit and a tab open. */
export const roomSearch = (
  taskId: string,
  options: { readonly tab?: WorkbenchTab; readonly attemptId?: string | null; readonly file?: string } = {},
) => ({
  room: taskId,
  ...(options.tab === undefined ? {} : { tab: options.tab }),
  ...(options.attemptId == null ? {} : { attempt: options.attemptId }),
  ...(options.file === undefined ? {} : { file: options.file }),
});

/** Opens the room on a Task of the thread's work, as a link to it would. */
export const useOpenRoom = (hobId: AgentId, threadId: ThreadId) => {
  const navigate = useNavigate();
  return (taskId: TaskId, options?: Parameters<typeof roomSearch>[1]) =>
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId, threadId },
      search: roomSearch(taskId, options),
    });
};

/**
 * Moves inside the open room. Lighting a lane, a tab and a try replace the address, so the browser's
 * Back leaves the room rather than stepping through them. Close room is the only way out. A lane
 * move puts the Quest's `top` Task in `room`, so a link that opened the room on a member's Task
 * lights that lane only until another lane, or none, is picked.
 */
export const useRoomMoves = (hobId: AgentId, threadId: ThreadId, top: TaskId | undefined) => {
  const navigate = useNavigate();
  const to = "/hobs/$hobId/threads/$threadId" as const;
  const params = { hobId, threadId };
  return {
    /** Lights a lane, or none; a try picked for another lane does not carry over. */
    lane: (taskId: TaskId | undefined) =>
      void navigate({
        from: to,
        to,
        params,
        search: (prev) => ({ room: top ?? prev.room, lane: taskId, tab: prev.tab }),
        replace: true,
      }),
    /** Lights a lane and opens the dock on its work. */
    show: (taskId: TaskId, tab: WorkbenchTab) =>
      void navigate({
        from: to,
        to,
        params,
        search: (prev) => ({ room: top ?? prev.room, lane: taskId, tab }),
        replace: true,
      }),
    /** Opens the dock on a tab, with a file to show first, or folds it. */
    tab: (tab: WorkbenchTab | undefined, file?: string) =>
      void navigate({ from: to, to, params, search: (prev) => ({ ...prev, tab, file }), replace: true }),
    /** Lights a lane on one of its Task's tries, so the lane and the Workbench show what it did. */
    pick: (taskId: TaskId, attemptId: AttemptId) =>
      void navigate({
        from: to,
        to,
        params,
        search: (prev) => ({ room: top ?? prev.room, lane: taskId, tab: prev.tab, attempt: attemptId }),
        replace: true,
      }),
    attempt: (attemptId: AttemptId) =>
      void navigate({ from: to, to, params, search: (prev) => ({ ...prev, attempt: attemptId }), replace: true }),
    /** Gives the chat its full width again, at the same place. */
    close: () => void navigate({ from: to, to, params, search: {} }),
  };
};

export type RoomMoves = ReturnType<typeof useRoomMoves>;
