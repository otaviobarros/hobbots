import type { Agent, BackpackItem, Task, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hobbots/ui/components/menu";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { agentsQuery } from "../../api/queries.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { reassignTargets } from "../quest/control-room.ts";
import type { HobLookup, Pins } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { laneMenu } from "./lane-actions-model.ts";
import { messages } from "./messages.ts";
import { StuckRetryItem, useStuckRetry } from "./stuck-retry-item.tsx";
import type { LaneActions } from "./use-lane-actions.ts";

type LaneMenuItems = ReturnType<typeof laneMenu>;

const NO_HOBS: ReadonlyArray<Agent> = [];

/** An item that changes the menu's view, so the menu stays open on it. */
const stayOpen = (go: () => void) => (event: Event) => {
  event.preventDefault();
  go();
};

/**
 * The ⋯ menu on a hob's lane (ADR 027): Show in the Workbench, then Retry while the Task failed or
 * its work is stuck, Reassign… on the hobs the hub would accept, and Cancel task…. The lead's lane has Pin quest and
 * Cancel quest… with what cancelling keeps. Radix moves focus into the menu, moves it with the
 * arrow keys, and gives it back to the ⋯ button when the menu closes.
 */
export function LaneMenu({
  tree,
  task,
  hobs,
  pins,
  actions,
  onWorkbench,
}: {
  tree: TaskTree;
  /** The Task the lane's header names, which the menu acts on. */
  task: Task;
  hobs: HobLookup;
  pins: Pins;
  actions: LaneActions;
  onWorkbench: () => void;
}) {
  const owner = hobs(task.ownerId).name;
  const open = actions.menuOf(task.id);
  const view = open?.view ?? null;
  // Reassign… on one of the hob's other failed Tasks gives that Task, not the header's.
  const target = tree.tasks.find((each) => each.id === open?.taskId) ?? task;
  const menu = laneMenu(tree, task);
  const stuck = useStuckRetry(task, hobs);
  // Cancel… opens its question in the lane, which takes focus, so the menu does not hand it back.
  const asked = useRef(false);
  const ask = (which: Task) => {
    asked.current = true;
    actions.ask(which.id);
  };
  return (
    <DropdownMenu
      open={view !== null}
      onOpenChange={(open) => (open ? actions.openMenu(task.id) : actions.closeMenu())}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={messages.menu({ name: owner })}>
          ⋯
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        key={view ?? "items"}
        align="end"
        aria-label={messages.menuOf({ name: owner })}
        onCloseAutoFocus={(event) => {
          if (asked.current) event.preventDefault();
          asked.current = false;
        }}
      >
        {view === "reassign" ? (
          <ReassignItems tree={tree} lane={task} task={target} actions={actions} />
        ) : view === "cancel" ? (
          <CancelItems task={task} cancel={menu.cancel} actions={actions} ask={ask} />
        ) : (
          <MenuItems
            task={task}
            stuck={stuck}
            owner={owner}
            menu={menu}
            pins={pins}
            actions={actions}
            ask={ask}
            onWorkbench={onWorkbench}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu's first view: what the lane's Task can do. */
function MenuItems({
  task,
  stuck,
  owner,
  menu,
  pins,
  actions,
  ask,
  onWorkbench,
}: {
  task: Task;
  /** The Task's stuck work, while Retry can send it again. */
  stuck: BackpackItem | undefined;
  owner: string;
  menu: LaneMenuItems;
  pins: Pins;
  actions: LaneActions;
  ask: (which: Task) => void;
  onWorkbench: () => void;
}) {
  // With one Task to cancel, Cancel task… asks about it; with more, the menu lists them.
  const only = menu.cancel.length === 1 ? menu.cancel[0] : undefined;
  return (
    <>
      <DropdownMenuItem onSelect={onWorkbench}>{messages.showInWorkbench}</DropdownMenuItem>
      {menu.pin && (
        <DropdownMenuItem onSelect={() => pins.toggle(task.id)}>
          {pins.pinned.includes(task.id) ? messages.unpin : messages.pin}
        </DropdownMenuItem>
      )}
      {menu.retry && (
        <DropdownMenuItem
          disabled={actions.busy}
          onSelect={() => actions.send(task.id, { kind: "retry", taskId: task.id })}
        >
          {messages.retry}
        </DropdownMenuItem>
      )}
      {stuck !== undefined && <StuckRetryItem item={stuck} />}
      {menu.reassign && (
        <DropdownMenuItem onSelect={stayOpen(() => actions.openMenu(task.id, "reassign"))}>
          {messages.reassign}
        </DropdownMenuItem>
      )}
      {(menu.cancel.length > 0 || menu.cancelTop !== null) && <DropdownMenuSeparator />}
      {menu.cancelTop !== null && (
        <DropdownMenuItem variant="deny" onSelect={() => ask(task)}>
          {menu.cancelTop === "quest" ? messages.cancelQuest : messages.cancelTask}
        </DropdownMenuItem>
      )}
      {menu.cancelTop === "quest" && <DropdownMenuLabel>{messages.cancelKeeps({ name: owner })}</DropdownMenuLabel>}
      {menu.cancel.length > 0 && (
        <DropdownMenuItem
          variant="deny"
          onSelect={only !== undefined ? () => ask(only) : stayOpen(() => actions.openMenu(task.id, "cancel"))}
        >
          {menu.pin ? messages.cancelStep : messages.cancelTask}
        </DropdownMenuItem>
      )}
    </>
  );
}

/** Cancel task…'s view when the hob has more than one Task to stop: each of them, then Back. */
function CancelItems({
  task,
  cancel,
  actions,
  ask,
}: {
  task: Task;
  cancel: ReadonlyArray<Task>;
  actions: LaneActions;
  ask: (which: Task) => void;
}) {
  return (
    <>
      <DropdownMenuLabel>{messages.cancelWhich}</DropdownMenuLabel>
      {cancel.map((each) => (
        <DropdownMenuItem key={each.id} variant="deny" inset onSelect={() => ask(each)}>
          {taskTitle(each)}
        </DropdownMenuItem>
      ))}
      <BackItem task={task} actions={actions} />
    </>
  );
}

/** Reassign…'s view: the hobs the hub would give the Task to, each with its sprite, then Back. */
function ReassignItems({
  tree,
  lane,
  task,
  actions,
}: {
  tree: TaskTree;
  /** The Task the lane's header names, whose menu Back returns to. */
  lane: Task;
  task: Task;
  actions: LaneActions;
}) {
  const active = (useQuery(agentsQuery).data ?? NO_HOBS).filter((hob) => hob.status !== "retired");
  const targets = reassignTargets(tree, task, active);
  return (
    <>
      <DropdownMenuLabel>{messages.reassignTo({ title: taskTitle(task) })}</DropdownMenuLabel>
      {targets.length === 0 && <DropdownMenuLabel>{messages.noOneElse}</DropdownMenuLabel>}
      {targets.map((hob) => (
        <DropdownMenuItem
          key={hob.id}
          disabled={actions.busy}
          inset
          onSelect={() => actions.send(task.id, { kind: "reassign", taskId: task.id, agentId: hob.id }, hob)}
        >
          <HobSprite hob={hob} size={16} />
          {hob.name}
        </DropdownMenuItem>
      ))}
      <BackItem task={lane} actions={actions} />
    </>
  );
}

/** Back to the menu's first view, after a separator. */
function BackItem({ task, actions }: { task: Task; actions: LaneActions }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={stayOpen(() => actions.openMenu(task.id))}>{messages.back}</DropdownMenuItem>
    </>
  );
}
