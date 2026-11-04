import { HOB_COLORS } from "@hobbots/art/look";
import { isTerminalTask, type Question, type Task, type TaskId, type TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SheetCloseButton, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@hobbots/ui/components/sheet";
import type { CSSProperties } from "react";
import { formatWhen } from "../../lib/time.ts";
import { TaskBackpack } from "../backpack/quest-backpack.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { attemptCount, roomStatus, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { NoteBox, type NoteDrafts } from "../quest/note-box.tsx";
import { AnswerForm, answerRoute } from "../quest/question-card.tsx";
import { TaskControlsFor } from "../quest/room-controls.tsx";
import { StatusTag } from "../quest/status-dot.tsx";
import { notAnAnswer, TaskDetail } from "../quest/task-detail.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { latestOf, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * The task sheet, slid in over the quest: back to the quest, the owner on its ground with the
 * task's title and "<owner> · attempt N · age", its state tag and note, a two-line summary, a
 * question waiting for you with its answer box, Review in chat and Open Workbench, its backpack,
 * everything else it holds behind a disclosure, the note box, and Retry, Reassign and Cancel.
 */
export function TaskView({
  tree,
  task,
  hobs,
  drafts,
  onOpen,
  onQuest,
  onReview,
  onWorkbench,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  drafts: NoteDrafts;
  onOpen: (taskId: TaskId) => void;
  onQuest: () => void;
  /** Closes the sheet on the chat, where its tray holds what needs you. */
  onReview: () => void;
  onWorkbench: (taskId: TaskId) => void;
}) {
  const top = tree.tasks[0] ?? task;
  const owner = hobs(task.ownerId);
  const status = roomStatus(tree, task);
  const question = tree.questions.find(
    (each) => each.taskId === task.id && each.state === "open" && each.recipientId === null,
  );
  const tone = roomTone(status);
  const summary = task.result?.summary ?? latestOf(tree, task) ?? task.brief;
  const live = !isTerminalTask(top.state);
  return (
    <>
      <SheetHeader>
        <Button variant="ghost" size="xs" onClick={onQuest} className="min-w-0 shrink text-text-secondary">
          <span aria-hidden>‹</span>
          <span className="truncate">{copy.back({ title: taskTitle(top) })}</span>
        </Button>
        <SheetCloseButton label={copy.close} />
      </SheetHeader>
      <div
        className="-mx-[18px] flex items-end gap-3 px-[18px] pt-1"
        style={{ "--hob": HOB_COLORS[owner.lookColor].hat } as CSSProperties}
      >
        <HobSprite hob={owner} size={56} state={status === "running" ? "working" : "idle"} />
        <div className="flex min-w-0 flex-col pb-2">
          {/* A brief's first line can be a paragraph: the heading stops at three lines, and the
              whole brief is under Everything in this task (#874). */}
          <SheetTitle tabIndex={-1} clamped className="text-title">
            {taskTitle(task)}
          </SheetTitle>
          <SheetDescription>
            {copy.meta({ name: owner.name, attempt: attemptCount(tree, task), age: formatWhen(task.createdAt) })}
          </SheetDescription>
        </div>
      </div>
      <div
        aria-hidden
        className="-mx-[18px] -mt-3.5 h-2 bg-[repeating-linear-gradient(90deg,color-mix(in_srgb,var(--hob)_55%,var(--color-deep))_0_8px,color-mix(in_srgb,var(--hob)_40%,var(--color-deep))_8px_16px)]"
        style={{ "--hob": HOB_COLORS[owner.lookColor].hat } as CSSProperties}
      />
      <span className="flex items-center gap-2">
        <StatusTag status={tone}>{question === undefined ? roomStatusLabel(status) : copy.asksYouTag}</StatusTag>
      </span>
      <p className="m-0 line-clamp-2 whitespace-pre-wrap text-text">{summary}</p>
      {question !== undefined && <AskedYou question={question} hobs={hobs} />}
      <div className="flex flex-wrap gap-2">
        {tone === "needs-you" && question === undefined && <Button onClick={onReview}>{copy.reviewInChat}</Button>}
        <Button variant="outline" onClick={() => onWorkbench(task.id)}>
          {copy.openWorkbench}
        </Button>
      </div>
      <TaskBackpack tree={tree} task={task} hobs={hobs} onOpen={onOpen} />
      <details className="text-detail">
        <summary className="cursor-pointer text-label">{copy.details}</summary>
        <div className="mt-3">
          <TaskDetail tree={tree} task={task} hobs={hobs} onOpen={onOpen} />
        </div>
      </details>
      {/* Once the work has ended nobody is left to read a note: talk to the lead in the chat. */}
      {live && (
        <NoteBox
          key={task.id}
          tree={tree}
          task={task}
          hobs={hobs}
          {...notAnAnswer(tree, task, hobs)}
          draft={drafts.get(task.id)}
          setDraft={(draft) => drafts.set(task.id, draft)}
        />
      )}
      {task.id !== top.id && (
        <SheetFooter className="border-t border-line pt-3">
          <TaskControlsFor key={task.id} tree={tree} task={task} hobs={hobs} onWorkbench={onWorkbench} bare />
        </SheetFooter>
      )}
    </>
  );
}

/**
 * A question the task's hob asked that climbed every lead to you: who asks, the question, who passed
 * it up and when, and the answer box. Your answer is a real answer, the same as in the Inbox.
 */
function AskedYou({ question, hobs }: { question: Question; hobs: HobLookup }) {
  const asker = hobs(question.askerId);
  const chain = [asker.name, ...question.chain.map((id) => hobs(id).name)];
  return (
    <section
      aria-label={copy.question.asks({ name: asker.name })}
      className="flex flex-col gap-2 rounded-card border-(length:--edge) border-lantern bg-card p-3"
    >
      <span className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-tile bg-tile">
          <HobSprite hob={asker} size={22} state="needs-you" />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-detail font-bold text-lantern">{copy.question.asks({ name: asker.name })}</span>
          <span className="whitespace-pre-wrap text-text-strong">{question.text}</span>
          <span className="text-meta text-label">
            {copy.question.passedUp({ chain, when: formatWhen(question.createdAt) })}
          </span>
        </span>
      </span>
      <AnswerForm question={question} askerName={asker.name} via="task" route={answerRoute(question, hobs)} />
    </section>
  );
}
