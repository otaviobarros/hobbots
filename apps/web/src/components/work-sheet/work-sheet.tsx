import type { AgentId, TaskId, ThreadId } from "@hobbots/domain";
import { Sheet, SheetContent, SheetTitle } from "@hobbots/ui/components/sheet";
import { useEffect, useRef, useState } from "react";
import { messages as questCopy } from "../quest/messages.ts";
import type { NoteDrafts } from "../quest/note-box.tsx";
import { type Pins, useFollowedTrees, useHobLookup, useOpenQuest, useOpenTask } from "../quest/use-work.ts";
import { findTask, taskTitle } from "../quest/work-model.ts";
import { useOpenWorkbench } from "../workbench/use-workbench.ts";
import { messages } from "./messages.ts";
import { QuestView } from "./quest-view.tsx";
import { TaskView } from "./task-view.tsx";
import { useComposerClearance } from "./use-composer-clearance.ts";

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
 * Going from the quest to a task, or Back, changes what the open sheet shows without closing it: the
 * sheet stays mounted, so it neither fades out and in again nor shifts the page (#894). Its content
 * starts again from the top, and focus moves to the new heading, the way it lands when the sheet opens.
 */
const useContentChange = (sheet: HTMLDivElement | null, shown: string | undefined) => {
  const last = useRef(shown);
  useEffect(() => {
    const before = last.current;
    last.current = shown;
    if (sheet === null || shown === undefined || before === undefined || before === shown) return;
    sheet.scrollTop = 0;
    sheet.querySelector<HTMLElement>('[data-slot="sheet-title"]')?.focus();
  }, [sheet, shown]);
};

/**
 * The work sheet over the end of the chat (ADR 018): a request's quest, or one task inside it, shown in
 * the same open sheet with a link back. What it shows is in the address, so a link opens it;
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
  // It ends above the composer, so what you type stays in view at any width (#515).
  const clearance = useComposerClearance(host, wanted !== undefined);
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const shown = wanted === undefined ? undefined : `${showTask ? "task" : "quest"}-${wanted}`;
  useContentChange(sheet, shown);
  return (
    <>
      <div ref={setHost} className="contents" />
      {/* Not modal: the chat and its header stay in reach, and a click on them closes the sheet. */}
      <Sheet modal={false} open={wanted !== undefined} onOpenChange={(open) => !open && close()}>
        <SheetContent
          ref={setSheet}
          aria-label={showTask ? questCopy.drawer.label({ title }) : copy.questLabel({ title })}
          // The label names the sheet, "<title>, Task details" or "<title>, quest", not the title alone.
          aria-labelledby={undefined}
          aria-describedby={undefined}
          container={host}
          className="absolute"
          style={clearance === undefined ? undefined : { bottom: clearance }}
          onOpenAutoFocus={focusTitle}
          onPointerDownOutside={keepForControls}
          onFocusOutside={stayOpen}
        >
          {found === null ? (
            <SheetTitle tabIndex={-1}>{copy.notFound}</SheetTitle>
          ) : showTask ? (
            <TaskView
              // Each Task starts its view afresh, its own note and open sections, inside the same sheet.
              key={shown}
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
            <QuestView key={shown} tree={found.tree} threadId={threadId} hobs={hobs} pins={pins} onOpen={openTask} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
