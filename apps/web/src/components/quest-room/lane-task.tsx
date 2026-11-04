import type { Question, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { formatWhen } from "../../lib/time.ts";
import { TaskBackpack } from "../backpack/quest-backpack.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import type { Lane } from "../lanes/lane-model.ts";
import { attemptCount, type RoomRow, roomRows, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { messages as questCopy } from "../quest/messages.ts";
import { AnswerForm, answerRoute } from "../quest/question-card.tsx";
import { TaskControlsFor } from "../quest/room-controls.tsx";
import { StatusTag } from "../quest/status-dot.tsx";
import { TaskDetail } from "../quest/task-detail.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { questionForYou, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const room = questCopy.room;

/**
 * The cards that close a hob's lane, one per Task it owns on the Quest and each of its steps, in tree
 * order: the lane above them already tells what the hob did.
 */
export function LaneCards({
  tree,
  lane,
  hobs,
  onOpen,
  onWorkbench,
}: {
  tree: TaskTree;
  lane: Lane;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
  onWorkbench: (taskId: TaskId) => void;
}) {
  const rows = roomRows(tree).filter((row) => row.task.ownerId === lane.hobId);
  return rows.map((row) => (
    <LaneTask
      key={row.task.id}
      tree={tree}
      row={row}
      titled={rows.length > 1}
      hobs={hobs}
      onOpen={onOpen}
      onWorkbench={onWorkbench}
    />
  ));
}

/**
 * One of a hob's Tasks at the end of its lane: which try it is on, a question that waits for you with its answer box,
 * Show in the Workbench, Retry, Reassign and Cancel, and everything else it holds behind a
 * disclosure (ADR 027).
 */
function LaneTask({
  tree,
  row,
  titled,
  hobs,
  onOpen,
  onWorkbench,
}: {
  tree: TaskTree;
  row: RoomRow;
  /** Whether the lane holds more than one Task, so each says which it is. */
  titled: boolean;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
  onWorkbench: (taskId: TaskId) => void;
}) {
  const { task } = row;
  const top = task.id === tree.tasks[0]?.id;
  const question = questionForYou(tree, task);
  return (
    <section
      aria-label={taskTitle(task)}
      className="flex min-w-0 flex-col gap-2 border-t border-line pt-2.5 text-detail wrap-anywhere"
    >
      {titled && (
        <span className="flex items-center gap-2">
          <h3 className="m-0 min-w-0 flex-1 truncate text-detail font-bold text-text-strong">{taskTitle(task)}</h3>
          <StatusTag status={roomTone(row.status)}>{roomStatusLabel(row.status)}</StatusTag>
        </span>
      )}
      <p className="m-0 text-meta text-label">
        {messages.taskMeta({ attempt: attemptCount(tree, task), age: formatWhen(task.createdAt) })}
      </p>
      <Flags row={row} hobs={hobs} />
      {question !== null && <AsksYou question={question} hobs={hobs} />}
      <span className="flex">
        <Button variant="outline" size="xs" onClick={() => onWorkbench(task.id)}>
          {messages.showInWorkbench}
        </Button>
      </span>
      {!top && <TaskControlsFor tree={tree} task={task} hobs={hobs} />}
      <TaskBackpack tree={tree} task={task} hobs={hobs} onOpen={onOpen} />
      <details>
        <summary className="cursor-pointer text-label">{messages.details}</summary>
        <div className="mt-3">
          <TaskDetail tree={tree} task={task} hobs={hobs} onOpen={onOpen} />
        </div>
      </details>
    </section>
  );
}

/**
 * What else the Task says: that its hob started a Quest of its own but brought nobody in yet, and
 * that another Task changed a file this one changed too (#570, #576).
 */
function Flags({ row, hobs }: { row: RoomRow; hobs: HobLookup }) {
  const sameFile = row.sameFileAs.map((id) => hobs(id).name);
  const nobody = row.quest?.state === "active" && row.party.length === 0;
  if (!nobody && sameFile.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-meta">
      {nobody && <span className="text-lantern">{room.nobodyYet}</span>}
      {sameFile.length > 0 && <span className="text-rose">{room.sameFile({ names: questCopy.names(sameFile) })}</span>}
    </span>
  );
}

/**
 * A question the hob asked that climbed every lead to you: who asks, the question, who passed it up
 * and when, and the answer box. Your answer is a real answer, the same as in the Inbox.
 */
function AsksYou({ question, hobs }: { question: Question; hobs: HobLookup }) {
  const asker = hobs(question.askerId);
  const chain = [asker.name, ...question.chain.map((id) => hobs(id).name)];
  return (
    <section
      aria-label={messages.asks({ name: asker.name })}
      className="flex flex-col gap-2 rounded-control border-(length:--edge) border-lantern bg-card p-2.5"
    >
      <span className="flex items-start gap-2">
        <HobSprite hob={asker} size={18} state="needs-you" />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-bold text-lantern">{messages.asks({ name: asker.name })}</span>
          <span className="whitespace-pre-wrap text-ui text-text-strong">{question.text}</span>
          <span className="text-meta text-label">
            {messages.passedUp({ chain, when: formatWhen(question.createdAt) })}
          </span>
        </span>
      </span>
      <AnswerForm question={question} askerName={asker.name} via="task" route={answerRoute(question, hobs)} />
    </section>
  );
}
