import type { AgentId, Task, TaskId, TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSendPrompt } from "../../api/queries.ts";
import { formatTime } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { StatusDot, StatusTag } from "./status-dot.tsx";
import { type HobLookup, useHobLookup, useOpenTask, useThreadTrees } from "./use-work.ts";
import { findTask, taskDetail, taskTitle } from "./work-model.ts";

const copy = messages.drawer;

/**
 * The drawer beside the chat that opens a Task or step (ADR 018): its brief, checkpoints, questions
 * and output, the Tasks under it, and a note that goes to the lead. The Task is in the address, so
 * a link opens it; Escape or Close shuts it.
 */
export function TaskDrawer({ hobId, threadId, taskId }: { hobId: AgentId; threadId: ThreadId; taskId: TaskId }) {
  const trees = useThreadTrees(threadId);
  const hobs = useHobLookup();
  const open = useOpenTask(hobId, threadId);
  const heading = useRef<HTMLHeadingElement>(null);
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
      className="flex w-[420px] shrink-0 animate-hb-in flex-col border-s-4 border-control bg-panel"
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
          <h2 ref={heading} tabIndex={-1} className="m-0 truncate font-pixel text-[17px] font-semibold outline-none">
            {found === null ? copy.notFound : title}
          </h2>
        </span>
      </header>
      {found !== null && <Detail tree={found.tree} task={found.task} hobs={hobs} onOpen={open} />}
      {found !== null && <NoteBox tree={found.tree} task={found.task} hobs={hobs} fallback={threadId} />}
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
                <span>{checkpoint.summary}</span>
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

/** A note on a Task goes to the lead as a message about that Task, in the lead's chat (ADR 018). */
function NoteBox({ tree, task, hobs, fallback }: { tree: TaskTree; task: Task; hobs: HobLookup; fallback: ThreadId }) {
  const top = tree.tasks[0] ?? task;
  const lead = hobs(top.ownerId);
  const send = useSendPrompt(top.threadId ?? fallback);
  const [note, setNote] = useState("");
  const text = note.trim();
  const submit = () => {
    if (text === "" || send.isPending) return;
    send.mutate(copy.note({ title: taskTitle(task), note: text }), { onSuccess: () => setNote("") });
  };
  return (
    <form
      className="flex flex-col gap-1.5 border-t-2 border-line px-3.5 pt-2.5 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span className="flex gap-2">
        <Textarea
          aria-label={copy.noteLabel({ name: lead.name })}
          placeholder={copy.noteLabel({ name: lead.name })}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-h-9 flex-1 rounded-none border-2 border-control bg-deep text-sm text-text"
        />
        <Button type="submit" size="sm" disabled={text === "" || send.isPending}>
          {copy.send}
        </Button>
      </span>
      <span role="status" className="text-xs text-label">
        {send.isError
          ? copy.noteFailed
          : send.isSuccess && note === ""
            ? copy.sent({ name: lead.name })
            : copy.noteHint({ name: lead.name })}
      </span>
    </form>
  );
}
