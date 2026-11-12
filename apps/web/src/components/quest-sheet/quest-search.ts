import type { AgentId, AttemptId, TaskId, ThreadId } from "@hobbots/domain";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { searchParam } from "../../lib/search-params.ts";
import { WorkbenchTab } from "../workbench/workbench-model.ts";

/**
 * Where a quest is in a thread's address (ADR 037, STD-REACT-002). `quest` names a Task of the
 * quest, which opens in the thread's sheet. `tab` opens the quest's Workbench beside the chat on that
 * tab instead, with `task` the Task whose hob's work it shows, `attempt` a try other than the one it
 * picks and `file` a file the tab shows first, with `from` the try that recorded it when more than one
 * did. `scope=task` narrows the Workbench to that Task alone, as Show in the Workbench on one of a
 * hob's Tasks does.
 */
export const QuestSearch = {
  quest: searchParam(Schema.String),
  task: searchParam(Schema.String),
  tab: searchParam(WorkbenchTab),
  attempt: searchParam(Schema.String),
  file: searchParam(Schema.String),
  from: searchParam(Schema.String),
  scope: searchParam(Schema.Literal("task")),
};

/** The quest the address asks for. */
export interface QuestView {
  /** A Task of the quest: its top Task, or the one a link named. */
  readonly taskId: TaskId;
  /** The Task whose hob's work the Workbench shows; undefined while it shows everyone's. */
  readonly task: TaskId | undefined;
  /** The Workbench tab while the Workbench is open beside the chat; undefined while the sheet shows the quest. */
  readonly tab: WorkbenchTab | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly file: string | undefined;
  /** The try that recorded `file`, so a link names one record when several Tasks touched the path. */
  readonly from: AttemptId | undefined;
  /** Whether the Workbench shows the named Task alone rather than its hob's work. */
  readonly taskOnly: boolean;
}

/** What a link puts in the address to open a quest on one of its Tasks: in the sheet, or its Workbench on a tab. */
export const questSearch = (
  taskId: string,
  options: { readonly tab?: WorkbenchTab; readonly attemptId?: string | null; readonly file?: string } = {},
) => ({
  quest: taskId,
  ...(options.tab === undefined ? {} : { tab: options.tab, task: taskId }),
  ...(options.attemptId == null ? {} : { attempt: options.attemptId }),
  ...(options.file === undefined ? {} : { file: options.file }),
});

const THREAD = "/hobs/$hobId/threads/$threadId" as const;

/** Opens a quest of the thread's work in its sheet, or its Workbench on a tab, as a link to it would. */
export const useOpenQuest = (hobId: AgentId, threadId: ThreadId) => {
  const navigate = useNavigate();
  return (taskId: TaskId, options?: Parameters<typeof questSearch>[1]) =>
    void navigate({ to: THREAD, params: { hobId, threadId }, search: questSearch(taskId, options) });
};

/**
 * Moves between a quest's sheet and its Workbench. Picking whose work and which try the Workbench
 * shows replaces the address, so the browser's Back leaves the Workbench rather than stepping through
 * them. Each keeps the quest's `top` Task in `quest`, so a link that named a member's Task shows that
 * hob's work only until another, or everyone, is picked.
 */
export const useQuestMoves = (hobId: AgentId, threadId: ThreadId, top: TaskId | undefined) => {
  const navigate = useNavigate();
  const params = { hobId, threadId };
  const go = (search: (prev: Record<string, unknown>) => Record<string, unknown>, replace = true) =>
    void navigate({ from: THREAD, to: THREAD, params, search, replace });
  return {
    /** Shows a hob's work in the Workbench, by one of its Tasks, on the tab it was on, else Changes; with none, everyone's. */
    lane: (taskId: TaskId | undefined) =>
      go((prev) => ({
        quest: top ?? prev.quest,
        task: taskId,
        tab: taskId === undefined ? prev.tab : (prev.tab ?? "changes"),
        scope: undefined,
      })),
    /** Shows one Task's work alone in the Workbench on a tab, with a file to show first, keeping the try picked for it. */
    show: (taskId: TaskId, tab: WorkbenchTab, options: { readonly file?: string; readonly attempt?: string } = {}) =>
      go(
        () => ({
          quest: top ?? taskId,
          task: taskId,
          tab,
          file: options.file,
          attempt: options.attempt,
          scope: "task" as const,
        }),
        false,
      ),
    /** Shows everyone's work in the Workbench on a tab: no hob, try or file picked. */
    everyone: (tab: WorkbenchTab) => go((prev) => ({ quest: top ?? prev.quest, tab }), false),
    /** Opens the Workbench on a tab, with a file to show first and the try that recorded it; with none, back to the quest's sheet. */
    tab: (tab: WorkbenchTab | undefined, file?: string, recordedBy?: AttemptId) =>
      go((prev) => (tab === undefined ? { quest: prev.quest } : { ...prev, tab, file, from: recordedBy })),
    /** Shows one of a Task's tries, so the Workbench follows what it did. */
    pick: (taskId: TaskId, attemptId: AttemptId) =>
      go((prev) => ({ quest: top ?? prev.quest, task: taskId, tab: prev.tab, attempt: attemptId })),
    attempt: (attemptId: AttemptId) => go((prev) => ({ ...prev, attempt: attemptId })),
    /** Back to the quest in the sheet, from the Workbench. */
    sheet: () => go((prev) => ({ quest: top ?? prev.quest }), false),
    /** Closes the quest: the chat alone, at the same place. */
    close: () => go(() => ({}), false),
  };
};

export type QuestMoves = ReturnType<typeof useQuestMoves>;
