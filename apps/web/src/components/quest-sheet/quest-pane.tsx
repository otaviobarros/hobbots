import { type AgentId, type Task, type TaskId, TaskPauses, type TaskTree, type ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hobbots/ui/components/menu";
import { SheetCloseButton, SheetHeader, SheetTitle } from "@hobbots/ui/components/sheet";
import { focusElement } from "@hobbots/ui/lib/restore-focus";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTaskControl } from "../../api/task-controls.ts";
import { threadTasksQuery } from "../../api/tasks.ts";
import { topCancel } from "../quest/control-room.ts";
import { FlagIcon } from "../quest/flag-icon.tsx";
import { messages as questCopy } from "../quest/messages.ts";
import { TopControls } from "../quest/room-controls.tsx";
import { StatusStrip } from "../quest/status-strip.tsx";
import { useQuestProgress } from "../quest/use-quest-progress.ts";
import { type HobLookup, type Pins, useFollowedTrees, useHobLookup } from "../quest/use-work.ts";
import { findTask, taskTitle, workCard } from "../quest/work-model.ts";
import { QuestCriteria } from "./criteria.tsx";
import { messages } from "./messages.ts";
import { PauseControls, pauseControl } from "./pause-controls.tsx";
import { QuestRead } from "./quest-read.tsx";
import { type QuestMoves, questSearch, useQuestMoves } from "./quest-search.ts";
import { QuestThreadView } from "./quest-thread-view.tsx";
import { RoomFinished, RoomStopped } from "./room-finished.tsx";
import { Team } from "./team.tsx";

const copy = messages.sheet;

/** Where Back goes from a quest in a camp's sheet: the camp's own sheet, by the camp's title. */
export interface QuestBack {
  readonly title: string;
  readonly go: () => void;
}

/**
 * A quest in its chat's or camp's sheet (ADR 037): Back to the camp, the quest's title under who
 * leads it, its progress, who is on it with what waits on you, and its thread, where you message the
 * lead and see whom it passed your message to. Show the work opens its Workbench beside the chat.
 * It is built from the hub's records, as the chat's ticket is, and stays live through their events.
 */
export function QuestPane({
  hobId,
  threadId,
  taskId,
  back,
  pins,
}: {
  hobId: AgentId;
  threadId: ThreadId;
  /** A Task of the quest: its top Task, or the one a link named. */
  taskId: TaskId;
  back: QuestBack | null;
  /** The pinned Quests, as the chat's header holds them, so a pin shows there at once. */
  pins: Pins;
}) {
  const followed = useFollowedTrees(threadId, pins.pinned);
  const read = useQuery(threadTasksQuery(threadId));
  const found = findTask([...followed.thread, ...followed.elsewhere], taskId);
  const hobs = useHobLookup();
  const moves = useQuestMoves(hobId, threadId, found?.tree.tasks[0]?.id);
  if (found === null) {
    return (
      <>
        <SheetHeader>
          {back !== null && <BackButton back={back} />}
          <SheetCloseButton label={copy.close} />
        </SheetHeader>
        <SheetTitle>{read.isPending ? copy.opening : messages.notFound}</SheetTitle>
        <QuestRead read={read} missing={false} />
      </>
    );
  }
  return (
    <QuestBody
      key={found.tree.tasks[0]?.id}
      tree={found.tree}
      threadId={threadId}
      hobs={hobs}
      pins={pins}
      moves={moves}
      back={back}
    />
  );
}

function BackButton({ back }: { back: QuestBack }) {
  return (
    <Button variant="ghost" size="sm" onClick={back.go} className="-ms-2 min-w-0">
      <span aria-hidden>←</span>
      <span className="truncate">{copy.back({ title: back.title })}</span>
    </Button>
  );
}

function QuestBody({
  tree,
  threadId,
  hobs,
  pins,
  moves,
  back,
}: {
  tree: TaskTree;
  threadId: ThreadId;
  hobs: HobLookup;
  pins: Pins;
  moves: QuestMoves;
  back: QuestBack | null;
}) {
  const [asking, setAsking] = useState(false);
  const pause = useTaskControl();
  const heading = useRef<HTMLHeadingElement>(null);
  // The title takes focus once the quest shows, after the sheet's own focus on opening. Another
  // quest mounts another body, keyed by its top Task.
  useEffect(() => {
    const frame = requestAnimationFrame(() => heading.current !== null && focusElement(heading.current));
    return () => cancelAnimationFrame(frame);
  }, []);
  const { segments, needs, done, total } = useQuestProgress(tree);
  const card = workCard(tree);
  if (card === null) return null;
  const { top } = card;
  const lead = hobs(card.leadId);
  const cancel = topCancel(tree);
  const title = taskTitle(top);
  return (
    <>
      <SheetHeader>
        {back !== null && <BackButton back={back} />}
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="icon" size="icon" aria-label={copy.menu({ title })}>
              ⋯
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => pins.toggle(top.id)}>
              {pins.pinned.includes(top.id) ? copy.unpin : copy.pin}
            </DropdownMenuItem>
            {TaskPauses.canPause(top) && (
              <DropdownMenuItem
                title={messages.paused.pauseNowHint}
                onSelect={() => pause.mutate(pauseControl(top, card.quest, true))}
              >
                {messages.paused.pauseNow}
              </DropdownMenuItem>
            )}
            {cancel === "open" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="deny" onSelect={() => setAsking(true)}>
                  {card.quest === null ? copy.cancelTask : copy.cancelQuest}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <SheetCloseButton label={copy.close} className="ms-0" />
      </SheetHeader>
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-meta font-semibold text-star">
          <FlagIcon size={12} />
          {card.quest === null ? messages.taskEyebrow({ name: lead.name }) : messages.questEyebrow({ name: lead.name })}
        </span>
        <SheetTitle ref={heading} clamped>
          {title}
        </SheetTitle>
        <span className="flex flex-wrap items-center gap-2 text-detail text-text-secondary">
          {copy.line({ done, total, name: lead.name })}
          {needs > 0 && <Badge variant="needs-you">{copy.needYou({ count: needs })}</Badge>}
        </span>
        <Elsewhere top={top} threadId={threadId} />
      </div>
      {segments.length > 0 && <StatusStrip statuses={segments} />}
      {(asking || cancel !== "open") && (
        <TopControls
          tree={tree}
          top={top}
          hobs={hobs}
          cancel={cancel}
          quest={card.quest}
          asked={{ open: asking, set: setAsking }}
        />
      )}
      <RoomFinished tree={tree} onChanges={() => moves.everyone("changes")} onFiles={() => moves.everyone("files")} />
      <RoomStopped tree={tree} />
      <span className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" title={copy.showWorkHint} onClick={() => moves.everyone("changes")}>
          {copy.showWork}
        </Button>
        <PauseControls top={top} quest={card.quest} owner={lead.name} control={pause} />
      </span>
      <QuestCriteria tree={tree} hobs={hobs} />
      <Team tree={tree} hobs={hobs} pins={pins} moves={moves} />
      <QuestThreadView tree={tree} threadId={threadId} lead={card.leadId} hobs={hobs} />
    </>
  );
}

/** A quest pinned from another thread says so, with a link to its own thread, where you message its lead. */
function Elsewhere({ top, threadId }: { top: Task; threadId: ThreadId }) {
  if (top.threadId === null || top.threadId === threadId) return null;
  return (
    <span className="flex items-center gap-2 text-meta text-label">
      {questCopy.room.elsewhere}
      <Link
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: top.ownerId, threadId: top.threadId }}
        search={questSearch(top.id)}
        className="text-link"
      >
        {questCopy.room.openThread}
      </Link>
    </span>
  );
}
