import type { AgentId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { OverflowTooltip } from "@hobbots/ui/components/overflow-tooltip";
import { focusElement } from "@hobbots/ui/lib/restore-focus";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { threadTasksQuery } from "../../api/tasks.ts";
import { laneRoom } from "../lanes/lane-model.ts";
import { FlagIcon } from "../quest/flag-icon.tsx";
import { type Pins, useFollowedTrees, useHobLookup } from "../quest/use-work.ts";
import { findTask, taskTitle, workCard } from "../quest/work-model.ts";
import { WorkbenchDock } from "../workbench/workbench-dock.tsx";
import { messages } from "./messages.ts";
import { QuestRead } from "./quest-read.tsx";
import { type QuestView, useQuestMoves } from "./quest-search.ts";

/**
 * A quest's Workbench beside the chat (ADR 023, ADR 037): what every hob of the quest changed, the
 * files and the terminals, opened from the quest in the chat's sheet. Back to the quest opens the
 * sheet again; Close gives the chat its full width. Opening it moves focus to the quest's title, and
 * closing it puts focus back in the chat, so the keyboard never lands on the page.
 */
export function QuestWorkbench({
  hobId,
  threadId,
  view,
  pins,
}: {
  hobId: AgentId;
  threadId: ThreadId;
  view: QuestView;
  pins: Pins;
}) {
  const followed = useFollowedTrees(threadId, pins.pinned);
  const read = useQuery(threadTasksQuery(threadId));
  const found = findTask([...followed.thread, ...followed.elsewhere], view.taskId);
  const hobs = useHobLookup();
  const tree = found?.tree;
  const top = tree?.tasks[0];
  const moves = useQuestMoves(hobId, threadId, top?.id);
  const heading = useRef<HTMLHeadingElement>(null);
  // The heading takes focus once the quest is read, and again only for another quest.
  const topId = top?.id;
  useEffect(() => {
    if (topId !== undefined && heading.current !== null) focusElement(heading.current);
  }, [topId]);
  const close = () => {
    moves.close();
    // The chat's composer takes focus back, where you would type next.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-composer] textarea")?.focus());
  };
  const card = tree === undefined ? null : workCard(tree);
  // The named Task's hob, else everyone's work; a Task alone is its own hob's.
  const lit = view.task !== undefined && tree?.tasks.some((task) => task.id === view.task) ? view.task : undefined;
  return (
    <section
      aria-label={card === null ? messages.workbench.label : messages.workbench.named({ title: taskTitle(card.top) })}
      className="flex min-w-0 flex-1 animate-hb-in flex-col overflow-hidden bg-ground"
    >
      <header className="flex items-center gap-3 border-b border-line py-2.5 ps-3 pe-5">
        {card !== null && (
          <Button variant="ghost" size="sm" onClick={moves.sheet}>
            <span aria-hidden>←</span>
            {messages.workbench.back}
          </Button>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          {card !== null && (
            <>
              <span className="flex items-center gap-1.5 text-meta font-bold text-star">
                <FlagIcon size={12} />
                {card.quest === null
                  ? messages.taskEyebrow({ name: hobs(card.leadId).name })
                  : messages.questEyebrow({ name: hobs(card.leadId).name })}
              </span>
              <OverflowTooltip text={taskTitle(card.top)}>
                <h2
                  ref={heading}
                  tabIndex={-1}
                  className="m-0 truncate font-heading text-title font-(--heading-weight) text-text-strong outline-none"
                >
                  {taskTitle(card.top)}
                </h2>
              </OverflowTooltip>
            </>
          )}
        </span>
        <Button variant="ghost" size="sm" title={messages.workbench.closeHint} onClick={close}>
          <span aria-hidden>✕</span>
          {messages.workbench.close}
        </Button>
      </header>
      {tree === undefined ? (
        <div className="px-6 py-4">
          <QuestRead read={read} missing />
        </div>
      ) : (
        <WorkbenchDock
          tree={tree}
          party={laneRoom(tree, []).order.length > 1}
          lit={lit}
          view={view}
          hobs={hobs}
          moves={moves}
        />
      )}
    </section>
  );
}
