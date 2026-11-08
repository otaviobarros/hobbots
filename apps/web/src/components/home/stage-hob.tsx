import type { Agent, TaskTree, Thread } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@hobbots/ui/components/popover";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ActivityMap } from "../../api/activity.ts";
import { changesLogQuery, readChangesSeen } from "../../api/hob-changes.ts";
import { useHobQuestWork } from "../../api/quest-work.ts";
import { threadTasksQuery } from "../../api/tasks.ts";
import type { HobState } from "../../lib/hob-state.ts";
import { useHobsNamed } from "../hob-changes/change-list.tsx";
import { changedByNote } from "../hob-changes/hob-changes-model.ts";
import { messages as changesCopy } from "../hob-changes/messages.ts";
import { doingOf, stateTag } from "../hob-page/hob-page-model.ts";
import { HobSprite, stateLabel } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { roomSearch } from "../quest-room/room-search.ts";
import { peekBench, peekThread } from "./home-model.ts";

const copy = messages.home;

/**
 * A hob on the Home stage: a bubble while it works, its sprite and its name tag. Clicking it opens
 * a peek below it with what it is doing, Open chat and, while it works on a Task, Open Workbench.
 * The popover keeps one peek open at a time and closes on Escape or a click outside.
 */
export function StageHob({
  hob,
  state,
  threads,
  activity,
  size,
  dimmed,
}: {
  hob: Agent;
  state: HobState;
  threads: ReadonlyArray<Thread>;
  activity: ActivityMap;
  size: number;
  /** A count chip that leaves this hob out dims it. */
  dimmed: boolean;
}) {
  const doing = doingOf(state, threads, activity);
  return (
    <div className={cn("flex flex-col items-center gap-1.5 transition-opacity", dimmed && "opacity-35")}>
      {doing?.kind === "live" && (
        <span
          title={doing.text}
          className="max-w-[150px] truncate rounded-control bg-card px-2 py-1 text-meta text-text shadow-menu"
        >
          {doing.text}
        </span>
      )}
      <Popover>
        <PopoverTrigger
          aria-label={copy.peekLabel({ name: hob.name, role: hob.roleTitle, state: stateLabel[state] })}
          className="hop-on-hover flex cursor-pointer flex-col items-center gap-1 border-0 bg-transparent p-0"
        >
          <HobSprite hob={hob} size={size} state={state} badge />
          <span className="rounded-tag bg-card px-2 py-px text-meta font-semibold whitespace-nowrap text-text-strong">
            {hob.name}
          </span>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="center" aria-label={hob.name} className="flex w-[260px] flex-col gap-2.5">
          <HobPeek hob={hob} state={state} threads={threads} activity={activity} />
        </PopoverContent>
      </Popover>
      <ChangedBy hob={hob} />
    </div>
  );
}

/**
 * "Changed by Ada" under a hob another hob changed last, until you open its profile, which the
 * note links to (ADR 034).
 */
function ChangedBy({ hob }: { hob: Agent }) {
  const log = useQuery(changesLogQuery);
  const by = log.data === undefined ? null : changedByNote(hob.id, log.data.changes, readChangesSeen()[hob.id]);
  const hobs = useHobsNamed(by === null ? [] : [by]);
  if (by === null) return null;
  const name = hobs.get(by)?.name ?? changesCopy.someHob;
  return (
    <Link
      to="/hobs/$hobId/profile"
      params={{ hobId: hob.id }}
      search={{ tab: "history" }}
      className="max-w-[150px] truncate rounded-tag bg-[color-mix(in_srgb,var(--color-lantern)_16%,var(--color-card))] px-2 py-px text-meta text-text"
    >
      {changesCopy.home.changedBy({ hob: name })}
    </Link>
  );
}

/** The peek's body, mounted only while it is open, so the Task reads wait for a click. */
function HobPeek({
  hob,
  state,
  threads,
  activity,
}: {
  hob: Agent;
  state: HobState;
  threads: ReadonlyArray<Thread>;
  activity: ActivityMap;
}) {
  const tag = stateTag(state);
  const thread = peekThread(threads, activity);
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-heading text-title font-bold text-text-strong">{hob.name}</span>
        <Badge variant={tag.variant}>
          <span aria-hidden data-slot="badge-glyph">
            {tag.glyph}
          </span>
          {tag.word}
        </Badge>
      </div>
      <span className="-mt-1.5 truncate text-detail text-text-secondary">{hob.roleTitle}</span>
      <span className="text-ui text-text">{doingOf(state, threads, activity)?.text ?? copy.peekResting}</span>
      <div className="flex flex-wrap gap-1.5">
        <Button asChild variant="outline" size="xs">
          {thread === null ? (
            <Link to="/hobs/$hobId/new" params={{ hobId: hob.id }}>
              {copy.openChat}
            </Link>
          ) : (
            <Link to="/hobs/$hobId/threads/$threadId" params={{ hobId: hob.id, threadId: thread.id }}>
              {copy.openChat}
            </Link>
          )}
        </Button>
        {thread === null ? (
          <WorkbenchLink hobId={hob.id} trees={[]} />
        ) : (
          <ChatWorkbenchLink hobId={hob.id} thread={thread} />
        )}
      </div>
    </>
  );
}

/** Open Workbench for a hob with a chat: the Task that chat works on comes first. */
function ChatWorkbenchLink({ hobId, thread }: { hobId: Agent["id"]; thread: Thread }) {
  const trees = useQuery(threadTasksQuery(thread.id)).data?.trees ?? [];
  return <WorkbenchLink hobId={hobId} threadId={thread.id} trees={trees} />;
}

/** Open Workbench, shown only while the hob works on a Task in its chat or on a Quest. */
function WorkbenchLink({
  hobId,
  threadId = null,
  trees,
}: {
  hobId: Agent["id"];
  threadId?: Thread["id"] | null;
  trees: ReadonlyArray<TaskTree>;
}) {
  const bench = peekBench(hobId, threadId, trees, useHobQuestWork(hobId));
  if (bench === null) return null;
  return (
    <Button asChild variant="ghost" size="xs">
      <Link
        to="/hobs/$hobId/threads/$threadId"
        params={{ hobId: bench.hobId, threadId: bench.threadId }}
        search={roomSearch(bench.taskId, { tab: "changes" })}
      >
        {copy.openWorkbench}
      </Link>
    </Button>
  );
}
