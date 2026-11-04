import type { AgentId, Attempt, AttemptId, Task, TaskId, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Tabs, TabsContent } from "@hobbots/ui/components/tabs";
import { useReturnFocus } from "@hobbots/ui/lib/restore-focus";
import { cn } from "@hobbots/ui/lib/utils";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentType, type ReactNode, useEffect, useId, useRef } from "react";
import { threadTasksQuery } from "../../api/tasks.ts";
import { attemptActivityQuery } from "../../api/workbench.ts";
import type { NoteDrafts } from "../quest/note-box.tsx";
import { type HobLookup, useFollowedTrees, useHobLookup } from "../quest/use-work.ts";
import { findTask, questionForYou, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { ChatPanelIcon } from "./tab-icons.tsx";
import { ChangesTab } from "./tabs/changes-tab.tsx";
import { FilesTab } from "./tabs/files-tab.tsx";
import { SummaryTab } from "./tabs/summary-tab.tsx";
import type { WorkbenchTabProps } from "./tabs/tab-props.ts";
import { TerminalTab } from "./tabs/terminal-tab.tsx";
import { useWorkbenchMoves, type WorkbenchView } from "./use-workbench.ts";
import { WorkbenchChat } from "./workbench-chat.tsx";
import { BackButton, WorkbenchHeader } from "./workbench-header.tsx";
import {
  type ActivityRead,
  attemptsOf,
  chosenAttempt,
  isWorkbenchTab,
  openingAttempt,
  type ProbedRead,
  type TabState,
  tabStates,
  WORKBENCH_TABS,
  type WorkbenchTab,
} from "./workbench-model.ts";
import { WorkbenchTabs } from "./workbench-tabs.tsx";

/** The tab that fills each panel; the Browser has none until it arrives (#382). */
const PANELS: Readonly<Record<Exclude<WorkbenchTab, "browser">, ComponentType<WorkbenchTabProps>>> = {
  summary: SummaryTab,
  changes: ChangesTab,
  files: FilesTab,
  terminal: TerminalTab,
};

/**
 * One Task's full view (ADR 023), in the chat's place: its header, its five tabs with honest
 * labels, its chat drawer, and Back to where it was opened from. The hob panel, the right panel and
 * a pinned Quest stay where they are. Escape goes back, and focus goes back to what opened it.
 */
export function Workbench({
  hobId,
  threadId,
  view,
  pinned,
  drafts,
}: {
  hobId: AgentId;
  threadId: ThreadId;
  view: WorkbenchView;
  /** Pinned Tasks from other threads, whose Workbenches open here too. */
  pinned: ReadonlyArray<TaskId>;
  /** Each Task's unsent note, the same one the Task drawer shows. */
  drafts: NoteDrafts;
}) {
  const followed = useFollowedTrees(threadId, pinned);
  const reading = useQuery(threadTasksQuery(threadId)).isPending;
  const found = findTask([...followed.thread, ...followed.elsewhere], view.taskId);
  const hobs = useHobLookup();
  const moves = useWorkbenchMoves(hobId, threadId);
  const chatId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  // Back, Escape and the browser's Back all close it, so focus returns when it goes, never to the page.
  useReturnFocus();
  const closeChat = () => {
    moves.chat(false);
    toggle.current?.focus();
  };
  const back = (
    <BackButton label={view.from === "drawer" ? messages.backToTask : messages.backToChat} onClick={moves.back} />
  );
  return (
    <section
      aria-label={messages.label({ title: found === null ? "" : taskTitle(found.task) })}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) moves.back();
      }}
      className="absolute inset-0 z-10 flex min-w-0 animate-hb-in flex-col bg-ground"
    >
      {found === null ? (
        <>
          <div className="flex items-center border-b border-line px-6 py-3">{back}</div>
          <p className="m-0 px-6 py-6 text-detail text-label">{reading ? messages.loading : messages.notFound}</p>
        </>
      ) : (
        <Bench
          key={found.task.id}
          tree={found.tree}
          task={found.task}
          view={view}
          hobs={hobs}
          moves={moves}
          back={back}
          end={
            <Button
              ref={toggle}
              variant="icon"
              size="icon"
              className="relative"
              aria-label={messages.chat.toggle}
              title={messages.chat.toggle}
              aria-pressed={view.chatOpen}
              aria-controls={view.chatOpen ? chatId : undefined}
              onClick={() => (view.chatOpen ? closeChat() : moves.chat(true))}
            >
              <ChatPanelIcon />
              {/* While the chat is hidden, a lantern dot says a question in it waits for you. */}
              {!view.chatOpen && questionForYou(found.tree, found.task) !== null && (
                <span aria-hidden className="absolute -end-1 -top-1 size-2 rounded-dot bg-lantern" />
              )}
            </Button>
          }
          chat={
            view.chatOpen && (
              <WorkbenchChat
                key={found.task.id}
                id={chatId}
                tree={found.tree}
                task={found.task}
                hobs={hobs}
                drafts={drafts}
                onClose={closeChat}
              />
            )
          }
        />
      )}
    </section>
  );
}

/**
 * The Attempt the Bench shows. With none chosen it opens on the latest that recorded work, reading
 * one Attempt's records at a time from the newest back: the one it shows is the one it reads, so
 * once that read finds nothing the next render moves to the one before (#386). The newer Attempts
 * it passed over stay read, so their records are not dropped from the cache and read again.
 */
const useShownAttempt = (
  tree: TaskTree,
  task: Task,
  attempts: ReadonlyArray<Attempt>,
  chosen: AttemptId | undefined,
): Attempt | null => {
  const queryClient = useQueryClient();
  const readOf = (each: Attempt): ProbedRead => {
    const state = queryClient.getQueryState(attemptActivityQuery(each.id).queryKey);
    if (state?.data !== undefined) return state.data.activity;
    return state?.status === "error" ? "failed" : "unread";
  };
  const shown = chosenAttempt(attempts, chosen, () => openingAttempt(tree, task, attempts, readOf));
  const passed = chosen === undefined && shown !== null ? attempts.filter((each) => each.number > shown.number) : [];
  useQueries({ queries: passed.map((each) => attemptActivityQuery(each.id)) });
  return shown;
};

function Bench({
  tree,
  task,
  view,
  hobs,
  moves,
  back,
  end,
  chat,
}: {
  tree: TaskTree;
  task: Task;
  view: WorkbenchView;
  hobs: HobLookup;
  moves: ReturnType<typeof useWorkbenchMoves>;
  back: ReactNode;
  end: ReactNode;
  /** The task chat, a card beside the views under the header, when it is open. */
  chat: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const attempts = attemptsOf(tree, task);
  const attempt = useShownAttempt(tree, task, attempts, view.attemptId);
  const read = useQuery({
    ...attemptActivityQuery(attempt?.id ?? ("" as AttemptId)),
    enabled: attempt !== null,
  });
  const activity: ActivityRead = attempt === null ? "none" : (read.data ?? (read.isError ? "failed" : "loading"));
  const states = tabStates(attempt, activity);
  // Opening a Task's Workbench moves focus to its title, so a keyboard user lands in it.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const shared = {
    tree,
    task,
    attempt,
    activity: typeof activity === "object" ? activity : null,
    hobs,
    onTab: moves.tab,
  };
  return (
    <>
      <WorkbenchHeader
        tree={tree}
        task={task}
        attempts={attempts}
        attempt={attempt}
        read={activity}
        hobs={hobs}
        headingRef={heading}
        back={back}
        onAttempt={moves.attempt}
        end={end}
      />
      {/* Narrower than 480px the task chat sits over the views instead of squeezing them. */}
      <div className="@container/bench relative flex min-h-0 flex-1 gap-4 p-4">
        <Tabs
          value={view.tab}
          onValueChange={(next) => isWorkbenchTab(next) && moves.tab(next)}
          className="min-h-0 min-w-0 flex-1"
        >
          <WorkbenchTabs states={states} />
          {/* Every panel stays mounted, so each keeps its scroll, selection and folds while another shows. */}
          <div className="relative mt-4 min-h-0 flex-1 overflow-hidden rounded-card border-(length:--edge) border-line bg-panel">
            {WORKBENCH_TABS.map((tab) => {
              const on = tab === view.tab;
              return (
                <TabsContent
                  key={tab}
                  value={tab}
                  forceMount
                  inert={!on}
                  className={cn("@container absolute inset-0 overflow-y-auto", !on && "invisible")}
                >
                  <TabNotice
                    tab={tab}
                    state={states[tab]}
                    owner={hobs(task.ownerId).name}
                    onRetry={() => void read.refetch()}
                  />
                  {tab !== "browser" && states[tab].kind !== "not-used" && (
                    <Panel tab={tab} props={{ ...shared, state: states[tab], focus: on ? view.file : undefined }} />
                  )}
                </TabsContent>
              );
            })}
          </div>
        </Tabs>
        {chat}
      </div>
    </>
  );
}

function Panel({ tab, props }: { tab: Exclude<WorkbenchTab, "browser">; props: WorkbenchTabProps }) {
  const Tab = PANELS[tab];
  return <Tab {...props} />;
}

/**
 * What the label says, in a sentence above the tab: why it is Unavailable, that the Task did not
 * use it, or that it is coming.
 */
function TabNotice({
  tab,
  state,
  owner,
  onRetry,
}: {
  tab: WorkbenchTab;
  state: TabState;
  owner: string;
  onRetry: () => void;
}) {
  const text =
    state.kind === "unavailable"
      ? messages.unavailable[state.reason]
      : state.kind === "coming-soon"
        ? messages.comingSoon
        : state.kind === "not-used" && tab !== "summary" && tab !== "browser"
          ? messages.notUsed[tab]({ name: owner })
          : null;
  if (text === null) return null;
  return (
    <p className="m-0 flex items-center gap-3 px-5 pt-4 text-detail text-text-secondary">
      <span>{text}</span>
      {state.kind === "unavailable" && state.reason === "unread" && (
        <Button variant="chip" size="xs" onClick={onRetry}>
          {messages.tryAgain}
        </Button>
      )}
    </p>
  );
}
