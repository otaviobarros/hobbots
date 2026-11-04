import type { AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { Sheet, SheetContent, SheetTitle } from "@hobbots/ui/components/sheet";
import { useState } from "react";
import { messages as questCopy } from "../quest/messages.ts";
import type { NoteDrafts } from "../quest/note-box.tsx";
import { type Pins, useFollowedTrees, useHobLookup, useOpenQuest, useOpenTask } from "../quest/use-work.ts";
import { findTask, taskTitle } from "../quest/work-model.ts";
import { useOpenWorkbench } from "../workbench/use-workbench.ts";
import { messages } from "./messages.ts";
import { QuestView } from "./quest-view.tsx";
import { TaskView } from "./task-view.tsx";

const copy = messages;

/**
 * A click on a control outside, such as another task's row or a link, decides itself what the sheet
 * shows next; closing first would race it. A click anywhere else outside closes the sheet.
 */
const keepForControls = (event: Event) => {
  const control = "a[href], button, input, textarea, select, [role='tab'], [role='button']";
  if (event.target instanceof Element && event.target.closest(control) !== null) event.preventDefault();
};

/** Focus may leave the sheet, to the composer or the chat header, without closing it. */
const stayOpen = (event: Event) => event.preventDefault();

/** Focus lands on the sheet's title, so a screen reader starts at what opened, the way a page does. */
const focusTitle = (event: Event) => {
  event.preventDefault();
  const sheet = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  sheet?.querySelector<HTMLElement>('[data-slot="sheet-title"]')?.focus();
};

/**
 * The work sheet over the end of the chat (ADR 018): a request's quest, or one task inside it, which
 * slides in over the quest with a link back. What it shows is in the address, so a link opens it;
 * Escape, ✕ or a click outside closes it, and focus goes back to where it was. A Quest pinned from
 * another thread opens here too.
 */
export function WorkSheet({
  hobId,
  threadId,
  questId,
  taskId,
  pins,
  drafts,
}: {
  hobId: AgentId;
  threadId: ThreadId;
  /** The top Task of the quest to show. */
  questId: TaskId | undefined;
  /** The Task to show, inside its quest. */
  taskId: TaskId | undefined;
  pins: Pins;
  /** Each Task's unsent note, so moving between Tasks never sends one about another. */
  drafts: NoteDrafts;
}) {
  const followed = useFollowedTrees(threadId, pins.pinned);
  const trees = [...followed.thread, ...followed.elsewhere];
  const hobs = useHobLookup();
  const openTask = useOpenTask(hobId, threadId);
  const openQuest = useOpenQuest(hobId, threadId);
  const openWorkbench = useOpenWorkbench(hobId, threadId);
  const close = () => openTask(undefined);
  const wanted = taskId ?? questId;
  const found = wanted === undefined ? null : findTask(trees, wanted);
  const showTask = taskId !== undefined;
  const title = found === null ? copy.notFound : taskTitle(found.task);
  // The sheet mounts in the chat's column, so the panels beside the chat stay in reach.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setHost} className="contents" />
      {/* Not modal: the chat and its header stay in reach, and a click on them closes the sheet. */}
      <Sheet modal={false} open={wanted !== undefined} onOpenChange={(open) => !open && close()}>
        <SheetContent
          aria-label={showTask ? questCopy.drawer.label({ title }) : copy.questLabel({ title })}
          // The label names the sheet, "<title>, Task details" or "<title>, quest", not the title alone.
          aria-labelledby={undefined}
          aria-describedby={undefined}
          container={host}
          className="absolute"
          onOpenAutoFocus={focusTitle}
          onPointerDownOutside={keepForControls}
          onFocusOutside={stayOpen}
          // The task view slides in over the quest; each opens from the end, the way it leaves.
          key={showTask ? `task-${taskId}` : `quest-${questId}`}
        >
          {found === null ? (
            <SheetTitle tabIndex={-1}>{copy.notFound}</SheetTitle>
          ) : showTask ? (
            <TaskView
              tree={found.tree}
              task={found.task}
              hobs={hobs}
              drafts={drafts}
              onOpen={openTask}
              onQuest={() => {
                const top = found.tree.tasks[0];
                if (top !== undefined) openQuest(top.id);
              }}
              onReview={close}
              onWorkbench={(id) => openWorkbench(id, "drawer")}
            />
          ) : (
            <QuestView tree={found.tree} threadId={threadId} hobs={hobs} pins={pins} onOpen={openTask} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
