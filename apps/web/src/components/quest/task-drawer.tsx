import { type AgentId, isTerminalTask, type Task, type TaskId, type TaskTree, type ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatTime } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { emptyNote, NoteBox, type NoteDraft } from "./note-box.tsx";
import { StatusDot, StatusTag } from "./status-dot.tsx";
import { type HobLookup, useFollowedTrees, useHobLookup, useOpenTask } from "./use-work.ts";
import { findTask, taskDetail, taskTitle } from "./work-model.ts";

const copy = messages.drawer;

/**
 * The drawer beside the chat that opens a Task or step (ADR 018): its brief, checkpoints, questions
 * and output, the Tasks under it, and a note that goes to its nearest lead. The Task is in the
 * address, so a link opens it; Escape or Close shuts it. A Task of a Quest pinned from another
 * thread opens here too, and its note still goes to that Quest's lead.
 */
export function TaskDrawer({
  hobId,
  threadId,
  taskId,
  pinned,
}: {
  hobId: AgentId;
  threadId: ThreadId;
  taskId: TaskId;
  /** Pinned Tasks from other threads, which open here too. */
  pinned: ReadonlyArray<TaskId>;
}) {
  const followed = useFollowedTrees(threadId, pinned);
  const trees = [...followed.thread, ...followed.elsewhere];
  const hobs = useHobLookup();
  const open = useOpenTask(hobId, threadId);
  const heading = useRef<HTMLHeadingElement>(null);
  // Each Task keeps its own unsent note, so moving between Tasks never sends one about another.
  const [drafts, setDrafts] = useState<ReadonlyMap<TaskId, NoteDraft>>(new Map());
  // Opening another Task moves focus to its title, so a keyboard user lands in the drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each Task opened moves focus again.
  useEffect(() => {
    heading.current?.focus();
  }, [taskId]);

  const found = findTask(trees, taskId);
  const title = found === null ? "" : taskTitle(found.task);
  return (
    <aside
      aria-label={copy.label({ title })}
      onKeyDown={(event) => {
        if (event.key === "Escape") open(undefined);
      }}
      className="absolute inset-y-0 end-0 z-10 flex w-drawer max-w-full animate-hb-in flex-col border-s-4 border-control bg-panel shadow-drawer"
    >
      <header className="flex items-center gap-2 border-b-2 border-line px-3.5 py-3">
        <Button variant="icon" size="icon" onClick={() => open(undefined)} aria-label={copy.close} title={copy.close}>
          ✕
        </Button>
        {found !== null && <HobSprite hob={hobs(found.task.ownerId)} size={22} />}
        <span className="flex min-w-0 flex-1 flex-col">
          {found?.parent != null && (
            <Button
              variant="link"
              size="xs"
              className="justify-start p-0 text-xs"
              onClick={() => found.parent && open(found.parent.id)}
            >
              {copy.back({ title: taskTitle(found.parent) })}
            </Button>
          )}
          <h2 ref={heading} tabIndex={-1} className="m-0 truncate font-pixel text-title font-semibold outline-none">
            {found === null ? copy.notFound : title}
          </h2>
        </span>
      </header>
      {found !== null && <Detail tree={found.tree} task={found.task} hobs={hobs} onOpen={open} />}
      {/* Once the work has ended nobody is left to read a note: talk to the lead in the chat. */}
      {found !== null && !isTerminalTask(found.tree.tasks[0]?.state ?? found.task.state) && (
        <NoteBox
          key={found.task.id}
          tree={found.tree}
          task={found.task}
          hobs={hobs}
          draft={drafts.get(found.task.id) ?? emptyNote()}
          setDraft={(draft) => setDrafts((all) => new Map(all).set(found.task.id, draft))}
        />
      )}
    </aside>
  );
}

function Detail({
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
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-3">
      <span className="flex items-center gap-2">
        <StatusTag status={detail.status}>{messages.status[detail.status]}</StatusTag>
        <span className="text-detail text-label">{hobs(task.ownerId).name}</span>
      </span>
      <Section title={detail.from === null ? copy.brief : copy.from({ name: hobs(detail.from).name })}>
        <div className="flex flex-col gap-1 border-2 border-line bg-card px-2.5 py-2 text-detail leading-snug">
          <span className="whitespace-pre-wrap">{detail.brief}</span>
          {detail.expected !== null && <span className="text-label">{copy.expected({ text: detail.expected })}</span>}
        </div>
      </Section>
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
                  className="flex w-full cursor-pointer items-center gap-2 border-0 bg-card px-2.5 py-1.5 text-start text-detail text-text hover:bg-hover"
                >
                  <StatusDot status={row.status} />
                  <HobSprite hob={hobs(row.task.ownerId)} size={16} />
                  <span className="min-w-0 flex-1 truncate">{taskTitle(row.task)}</span>
                  <StatusTag status={row.status}>{messages.status[row.status]}</StatusTag>
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
                {checkpoint.source !== "automatic" && <span>{checkpoint.summary}</span>}
              </li>
            ))}
          </ol>
        )}
      </Section>
      {detail.questions.length > 0 && (
        <Section title={copy.questions}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-detail">
            {detail.questions.map((question) => (
              <li key={question.id} className="flex flex-col gap-0.5">
                <span>{question.text}</span>
                {question.answer !== null && (
                  <span className="text-mint">
                    {copy.answer({
                      name: question.answeredBy?._tag === "Lead" ? hobs(question.answeredBy.agentId).name : copy.you,
                      answer: question.answer,
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {detail.notes.length > 0 && (
        <Section title={copy.notes}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-detail">
            {detail.notes.map((note) => (
              <li key={note.id} className="flex flex-col gap-0.5 border-s-2 border-lantern ps-2">
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
      {detail.given.length > 0 && (
        <Section title={copy.given}>
          <Artifacts artifacts={detail.given} />
        </Section>
      )}
    </div>
  );
}

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
