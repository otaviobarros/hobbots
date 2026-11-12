import type { Task, TaskId, TaskTree } from "@hobbots/domain";
import { Tabs } from "@hobbots/ui/components/tabs";
import { type RefObject, useRef } from "react";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages as roomCopy } from "../quest-sheet/messages.ts";
import type { QuestMoves, QuestView } from "../quest-sheet/quest-search.ts";
import { DockBar } from "./dock-bar.tsx";
import type { DockSource } from "./dock-model.ts";
import { DockPanel } from "./dock-panel.tsx";
import { useDockRead } from "./use-dock-read.ts";
import { WorkbenchHeader } from "./workbench-header.tsx";
import { attemptsOf, isWorkbenchTab, WORKBENCH_TABS } from "./workbench-model.ts";

/**
 * One Workbench for the whole quest (ADR 023), beside the chat once a quest's sheet opens it
 * (ADR 037). Changes, Files and Terminal list every hob's work in one list, or one hob's alone, each
 * on the try picked for its Task. It reads the quest's tree in one call and stays live through the
 * tree's one stream.
 */
export function WorkbenchDock({
  tree,
  party,
  lit,
  view,
  hobs,
  moves,
}: {
  tree: TaskTree;
  /** Whether more than one hob works on the quest. */
  party: boolean;
  /** The Task whose hob's work it shows, or undefined while it shows everyone's. */
  lit: TaskId | undefined;
  view: QuestView;
  hobs: HobLookup;
  moves: QuestMoves;
}) {
  const { top, ownerId, litTask, only, sources, roots, states, counts, retry } = useDockRead(tree, party, lit, view);
  const heading = useRef<HTMLHeadingElement>(null);
  if (top === undefined) return null;
  const shared = { tree, sources, roots, hobs, onTab: moves.tab };
  return (
    <section
      aria-label={roomCopy.dock.named({ title: taskTitle(top) })}
      className="@container/dock flex min-h-0 flex-1 flex-col border-t border-line bg-deep"
    >
      <Tabs
        value={view.tab ?? ""}
        onValueChange={(next) => isWorkbenchTab(next) && moves.tab(next)}
        className="min-h-0 flex-1"
      >
        <DockBar
          states={states}
          counts={counts}
          // The chip names the hob, never a Task: a Task's title is its brief, which can run to a
          // paragraph, and the Task's header over the panels already names it.
          filter={ownerId === undefined || only === undefined ? null : hobs(ownerId)}
          party={party}
          onEveryone={() => moves.lane(undefined)}
        />
        {litTask !== undefined && (
          <LitHeader tree={tree} task={litTask} sources={sources} hobs={hobs} heading={heading} moves={moves} />
        )}
        {/* Every panel stays mounted, so each keeps its scroll, selection and folds while another shows. */}
        <div className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-card border-(length:--edge) border-line bg-panel">
          {WORKBENCH_TABS.map((tab) => (
            <DockPanel
              key={tab}
              tab={tab}
              on={tab === view.tab}
              state={states[tab]}
              props={shared}
              file={view.file}
              from={view.from}
              labels={litTask === undefined}
              onRetry={retry}
            />
          ))}
        </div>
      </Tabs>
    </section>
  );
}

/**
 * The Task whose hob's work it shows, over the panels, or a Task alone's: its hob, title and byline, Live or
 * History, and the try every tab follows once it was retried.
 */
function LitHeader({
  tree,
  task,
  sources,
  hobs,
  heading,
  moves,
}: {
  tree: TaskTree;
  task: Task;
  sources: ReadonlyArray<DockSource>;
  hobs: HobLookup;
  heading: RefObject<HTMLHeadingElement | null>;
  moves: QuestMoves;
}) {
  const source = sources.find((each) => each.task.id === task.id);
  const attempts = attemptsOf(tree, task);
  return (
    <WorkbenchHeader
      tree={tree}
      task={task}
      attempts={attempts}
      attempt={source?.attempt ?? null}
      read={source?.activity ?? (attempts.length === 0 ? "none" : "loading")}
      hobs={hobs}
      headingRef={heading}
      onAttempt={moves.attempt}
    />
  );
}
