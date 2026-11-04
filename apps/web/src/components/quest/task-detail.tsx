import { type Question, saysMore, type Task, type TaskId, type TaskTree } from "@hobbots/domain";
import type { ReactNode } from "react";
import { formatTime } from "../../lib/time.ts";
import { TaskApprovals, useShownApprovals } from "../approvals/task-approvals.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { roomStatus, roomStatusLabel, roomTone } from "./control-room.ts";
import { messages } from "./messages.ts";
import { StatusDot, StatusTag } from "./status-dot.tsx";
import type { HobLookup } from "./use-work.ts";
import { noteRecipient, taskDetail, taskTitle } from "./work-model.ts";
import { yourAnswer } from "./your-answer.ts";

const copy = messages.drawer;

/**
 * What a Task holds, under the top of its sheet (ADR 018): its brief, folders, milestones, the Tasks
 * under it, checkpoints, questions, your notes, its output and what it was handed. A question waiting
 * for you is answered at the top of the sheet, not here.
 */
export function TaskDetail({
  tree,
  task,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const detail = taskDetail(tree, task);
  return (
    <div className="flex flex-col gap-3.5">
      <WaitingApprovals approvals={detail.approvals} />
      <Section title={detail.from === null ? copy.brief : copy.from({ name: hobs(detail.from).name })}>
        <div className="flex flex-col gap-1 border-2 border-line bg-card px-2.5 py-2 text-detail leading-snug">
          <span className="whitespace-pre-wrap">{detail.brief}</span>
          {detail.expected !== null && <span className="text-label">{copy.expected({ text: detail.expected })}</span>}
        </div>
      </Section>
      {detail.folders !== null && (
        <Section title={copy.folders}>
          {detail.folders.length === 0 ? (
            <p className="m-0 text-detail text-label">{copy.noFolders}</p>
          ) : (
            <ul aria-label={copy.folders} className="m-0 flex list-none flex-col gap-1 p-0 text-detail">
              {detail.folders.map((folder) => (
                <li key={folder} className="break-all font-mono text-xs">
                  {folder}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {detail.milestones.length > 0 && (
        <Section title={copy.milestones}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-detail">
            {detail.milestones.map((milestone) => (
              <li key={milestone.id} className="flex items-center gap-2">
                <span className={milestone.reachedAt === null ? "text-label" : "text-mint"}>
                  {milestone.reachedAt === null ? "○" : "✓"}
                </span>
                <span className="flex-1">{milestone.title}</span>
                <span className="sr-only">{milestone.reachedAt === null ? copy.notReached : copy.reached}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.rows.length > 0 && (
        <Section title={copy.tasks}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.rows.map((row) => (
              <li key={row.task.id}>
                <button
                  type="button"
                  onClick={() => onOpen(row.task.id)}
                  className="flex w-full cursor-pointer items-center gap-2 border-0 bg-card px-2.5 py-1.5 text-start text-detail text-text-strong hover:bg-hover"
                >
                  <StatusDot status={roomTone(roomStatus(tree, row.task))} />
                  <HobSprite hob={hobs(row.task.ownerId)} size={16} />
                  <span className="min-w-0 flex-1 truncate">{taskTitle(row.task)}</span>
                  <StatusTag status={roomTone(roomStatus(tree, row.task))}>
                    {roomStatusLabel(roomStatus(tree, row.task))}
                  </StatusTag>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={copy.checkpoints}>
        {detail.checkpoints.length === 0 ? (
          <p className="m-0 text-detail text-label">{copy.noCheckpoints}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {detail.checkpoints.map((checkpoint) => (
              <li key={checkpoint.id} className="flex gap-2 text-detail leading-snug">
                <time dateTime={checkpoint.createdAt} className="w-14 shrink-0 text-label">
                  {formatTime(checkpoint.createdAt)}
                </time>
                <span className="h-fit shrink-0 bg-line px-1.5 text-xs font-bold text-moonlight">
                  {messages.checkpoint[checkpoint.kind]}
                </span>
                {saysMore(checkpoint) && <span>{checkpoint.summary}</span>}
              </li>
            ))}
          </ol>
        )}
      </Section>
      {detail.questions.length > 0 && (
        <Section title={copy.questions}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-detail">
            {detail.questions.map((question) => (
              <li key={question.id} className="flex flex-col gap-1">
                <span>{question.text}</span>
                {question.state === "open" && <OpenQuestion question={question} hobs={hobs} />}
                {question.answer !== null && (
                  <span className="text-mint">
                    {question.answeredBy?._tag === "Lead"
                      ? copy.answer({ name: hobs(question.answeredBy.agentId).name, answer: question.answer })
                      : yourAnswer(question, "task")}
                  </span>
                )}
                {question.state === "withdrawn" && <span className="text-text-secondary">{copy.withdrawn}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.notes.length > 0 && (
        <Section title={copy.notes}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-detail">
            {detail.notes.map((note) => (
              <li key={note.id} className="flex flex-col gap-0.5 bg-deep px-2 py-1.5">
                <span className="whitespace-pre-wrap">{note.text}</span>
                <span className="text-xs text-label">
                  {copy.noteTo({ name: hobs(note.recipientId).name, time: formatTime(note.createdAt) })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={copy.output}>
        {detail.output.length === 0 && task.result === null ? (
          <p className="m-0 text-detail text-label">{copy.noOutput}</p>
        ) : (
          <div className="flex flex-col gap-1.5 text-detail">
            {task.result !== null && <p className="m-0 whitespace-pre-wrap">{task.result.summary}</p>}
            <Artifacts artifacts={detail.output} />
          </div>
        )}
      </Section>
      {(detail.given.length > 0 || detail.returned.length > 0) && (
        <Section title={copy.given}>
          <div className="flex flex-col gap-1.5 text-detail">
            {detail.returned.map((done) => (
              <p key={done.id} className="m-0 whitespace-pre-wrap">
                {copy.returned({ name: hobs(done.ownerId).name, summary: done.result?.summary ?? "" })}
              </p>
            ))}
            <Artifacts artifacts={detail.given} />
          </div>
        </Section>
      )}
    </div>
  );
}

/** What the Task's turn waits on you to approve, decided right here as in the Inbox, then how it ended (#698). */
function WaitingApprovals({ approvals }: { approvals: ReturnType<typeof taskDetail>["approvals"] }) {
  const shown = useShownApprovals(approvals);
  if (shown.length === 0) return null;
  return (
    <Section title={copy.approvals}>
      <TaskApprovals approvals={shown} />
    </Section>
  );
}

/** An open question: who it waits on, or that it waits for you, answered at the top of the sheet. */
function OpenQuestion({ question, hobs }: { question: Question; hobs: HobLookup }) {
  if (question.recipientId === null) return <span className="text-lantern">{copy.waitsForYou}</span>;
  return <span className="text-label">{copy.waitingOn({ name: hobs(question.recipientId).name })}</span>;
}

/**
 * While a question on the Task waits for you, the note box says it sends a note to the lead and
 * points at the answer box, so nobody types an answer into it.
 */
export const notAnAnswer = (tree: TaskTree, task: Task, hobs: HobLookup) => {
  const waiting = tree.questions.find(
    (question) => question.taskId === task.id && question.state === "open" && question.recipientId === null,
  );
  if (waiting === undefined) return {};
  const lead = hobs(noteRecipient(tree, task)).name;
  return {
    label: copy.noteNotAnswer({ name: lead }),
    hint: copy.noteNotAnswerHint({ lead, asker: hobs(waiting.askerId).name }),
  };
};

function Artifacts({ artifacts }: { artifacts: ReturnType<typeof taskDetail>["output"] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-detail">
      {artifacts.map((artifact) => (
        <li key={artifact.id} className="flex flex-col gap-0.5 border-2 border-line bg-card px-2.5 py-1.5">
          <span className="font-bold">{artifact.label}</span>
          {artifact.kind === "link" ? (
            <a href={artifact.value} target="_blank" rel="noreferrer" className="break-all text-lantern">
              {artifact.value}
            </a>
          ) : (
            <span className={artifact.kind === "file" ? "font-mono break-all" : "whitespace-pre-wrap"}>
              {artifact.value}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="lbl m-0 text-xs text-label">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A note on a Task goes to its nearest lead as a message about that Task (ADR 018), which the lead
 * reads in its next turn; it shows under Notes once the hub has it. Each note keeps one key while it
 * is retried, so a lost reply never leaves it twice.
 */
