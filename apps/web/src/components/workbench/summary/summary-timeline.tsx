import { TASK_TOOLS, type TaskId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { formatCount } from "../../../lib/format.ts";
import type { HobLookup } from "../../quest/use-work.ts";
import { taskTitle } from "../../quest/work-model.ts";
import { messages } from "../messages.ts";
import type { HappenedLine, Mark, Summary } from "./summary-model.ts";

const copy = messages.summary;

const GLYPH: Readonly<Record<Mark, string>> = {
  done: "✓",
  failed: "✕",
  waiting: "◷",
  running: "●",
  next: "›",
  cancelled: "■",
  unresolved: "!",
};

const GLYPH_TONE: Readonly<Record<Mark, string>> = {
  done: "bg-line text-mint",
  failed: "bg-line text-rose",
  waiting: "bg-line text-text-secondary",
  running: "bg-line text-mint",
  next: "bg-line text-label",
  cancelled: "bg-line text-text-secondary",
  unresolved: "bg-rose text-on-rose",
};

/** What happened, as a card of lines, each led by its mark's glyph, the glyphs joined by a line. */
export function Timeline({
  summary,
  owner,
  running,
  hobs,
  onOpen,
}: {
  summary: Summary;
  owner: string;
  running: boolean;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const lines = summary.happened;
  return (
    <section
      aria-label={copy.happened}
      className="flex flex-col gap-2 rounded-card border-(length:--edge) border-line bg-card px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2 px-2.5">
        <h3 className="lbl m-0 text-meta text-label">{copy.happened}</h3>
        {lines.length > 0 && (
          <span aria-hidden className="rounded-dot bg-line px-1.5 text-meta text-label">
            {formatCount(lines.length)}
          </span>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="m-0 px-2.5 text-detail text-text-secondary">
          {running ? copy.nothingYet({ name: owner }) : copy.nothingHappened({ name: owner })}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {lines.map((line, index) => (
            <li key={lineKey(line)} className="relative">
              {index < lines.length - 1 && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute start-5 top-6.5 -bottom-1.5 w-(--edge) -translate-x-1/2 bg-line-2 rtl:translate-x-1/2"
                />
              )}
              <Happened line={line} hobs={hobs} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const lineKey = (line: HappenedLine): string => {
  switch (line.kind) {
    case "step":
    case "member":
      return line.task.id;
    case "checkpoint":
      return line.checkpoint.id;
    case "milestone":
      return line.milestone.id;
    case "refused":
      return `refused-${line.refusal.id}`;
    case "tool":
      return `tool-${line.step.id}`;
    case "ended":
      return `ended-${line.attempt.id}`;
  }
};

/** One line of What happened, with its mark in words; a step or a member's Task opens its own Workbench. */
function Happened({ line, hobs, onOpen }: { line: HappenedLine; hobs: HobLookup; onOpen: (taskId: TaskId) => void }) {
  const mark = (
    <span
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center rounded-tag text-meta font-bold",
        GLYPH_TONE[line.mark],
      )}
    >
      <span aria-hidden>{GLYPH[line.mark]}</span>
      <span className="sr-only">{copy.mark[line.mark]}</span>
    </span>
  );
  const row = "flex items-start gap-2.5 px-2.5 py-1.5 text-detail leading-snug";
  if (line.kind === "step" || line.kind === "member") {
    const title = taskTitle(line.task);
    const text =
      line.kind === "step"
        ? copy.step({ index: line.index, total: line.total, title })
        : copy.member({ name: hobs(line.task.ownerId).name, title });
    return (
      <button
        type="button"
        onClick={() => onOpen(line.task.id)}
        aria-label={copy.lineLabel({ line: text, mark: copy.mark[line.mark], title })}
        className={cn(
          row,
          "w-full cursor-pointer rounded-control border-0 bg-transparent text-start text-text-strong hover:bg-hover",
        )}
      >
        {mark}
        <span className="min-w-0 flex-1">{text}</span>
        {line.tries > 1 && <span className="shrink-0 text-meta text-label">{copy.tries({ count: line.tries })}</span>}
      </button>
    );
  }
  if (line.kind === "refused") return <Refused line={line} hobs={hobs} mark={mark} row={row} />;
  if (line.kind === "tool") {
    return (
      <div data-slot="tool-step" className={row}>
        {mark}
        <span className="min-w-0 flex-1 whitespace-pre-wrap">
          {line.step.label}
          {line.step.reason !== undefined && (
            <span className="block text-text-secondary">{copy.endedWhy({ why: line.step.reason })}</span>
          )}
        </span>
      </div>
    );
  }
  const more = moreOf(line);
  return (
    <div className={row}>
      {mark}
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {textOf(line)}
        {more !== null && <span className="block text-text-secondary">{more}</span>}
      </span>
    </div>
  );
}

type PlainLine = Extract<HappenedLine, { readonly kind: "checkpoint" | "milestone" | "ended" }>;

/** What a checkpoint, a milestone or an Attempt's end says on its line. */
const textOf = (line: PlainLine): string =>
  line.kind === "checkpoint"
    ? line.checkpoint.summary
    : line.kind === "milestone"
      ? copy.milestone({ title: line.milestone.title })
      : line.mark === "failed"
        ? copy.endedFailed
        : line.mark === "unresolved"
          ? copy.endedUnresolved
          : copy.endedStopped;

/**
 * What the line adds under it: what the hob had to say beyond its checkpoint's short beat, which the
 * Workbench shows and a lane never does (#901), or why an Attempt ended.
 */
const moreOf = (line: PlainLine): string | null =>
  line.kind === "checkpoint"
    ? line.checkpoint.detail
    : line.kind === "ended" && line.attempt.outcome !== null
      ? copy.endedWhy({ why: line.attempt.outcome })
      : null;

/** A Task tool call the hub refused: the step it was, what the hob was told, and how many times it tried. */
function Refused({
  line,
  hobs,
  mark,
  row,
}: {
  line: Extract<HappenedLine, { kind: "refused" }>;
  hobs: HobLookup;
  mark: ReactNode;
  row: string;
}) {
  const { refusal } = line;
  const label = TASK_TOOLS.find((tool) => tool.name === refusal.tool)?.label ?? refusal.tool;
  return (
    <div data-slot="refused-call" className={row}>
      {mark}
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {copy.refused({ label })}
        <span className="block text-text-secondary">
          {copy.refusedTold({ name: hobs(refusal.agentId).name, message: refusal.message })}
        </span>
      </span>
      {refusal.tries > 1 && (
        <span className="shrink-0 text-meta text-label">{copy.tries({ count: refusal.tries })}</span>
      )}
    </div>
  );
}
