import { type ReplyStep, stepCommand, type ToolCall, type ToolOutput } from "@hobbots/domain";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@hobbots/ui/components/collapsible";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { formatBytes } from "../../lib/format.ts";
import { operationLabel, shownSteps } from "../../lib/reply-steps.ts";
import { minutesBetween, minutesSince } from "../../lib/reply-wait.ts";
import { formatTime } from "../../lib/time.ts";
import { useNow } from "../inbox/use-now.ts";
import { messages } from "../messages.ts";
import { LogLink, OutputBlock } from "./tool-output.tsx";

type StepState = ReplyStep["state"];

const copy = messages.steps;

/** The mark before each step, and its color. A running step blinks until Reduce motion stops it. */
const MARK: Record<StepState, { readonly glyph: string; readonly className: string }> = {
  running: { glyph: "●", className: "animate-hb-blink text-lantern" },
  awaiting: { glyph: "◷", className: "text-lantern" },
  done: { glyph: "✓", className: "text-mint" },
  failed: { glyph: "✗", className: "text-rose" },
  denied: { glyph: "⊘", className: "text-rose" },
  unfinished: { glyph: "■", className: "text-label" },
  uncertain: { glyph: "?", className: "font-bold text-lantern" },
  stopped: { glyph: "■", className: "text-label" },
};

/** A running command the reply waits on, once its hob has answered: a still mark, nothing is written (#1056). */
const WAITED = { glyph: "◷", className: "text-mint" } as const;

/** Whether the reply waits on this step's command. */
const waitedOn = (step: ReplyStep) => step.state === "running" && step.waitedOn === true;

/** Where a step's full log is served. */
type LogUrl = (stepId: string) => string;

/**
 * What a reply did besides writing, as the runtime reported it. While the reply runs every step
 * shows; once it ends, its tool calls stay. A tool step opens to show the tool, the action, its
 * targets and what it printed; a refused one says why.
 */
export function ReplySteps({
  steps,
  inProgress,
  logUrl,
  settle,
}: {
  steps: ReadonlyArray<ReplyStep>;
  inProgress: boolean;
  logUrl: LogUrl;
  /** What an uncertain tool step offers to settle it, such as a Charm call's (ADR 020). */
  settle?: (stepId: string) => ReactNode;
}) {
  const shown = shownSteps(steps, inProgress);
  if (shown.length === 0) return null;
  return (
    <ol
      aria-label={copy.list}
      className="m-0 flex list-none flex-col gap-[3px] rounded-card border-(length:--edge) border-line bg-panel px-2.5 py-2 text-detail"
    >
      {shown.map((step) => (
        <li key={step.id} data-state={step.state}>
          {step.kind === "tool" && step.call ? (
            <ToolStep
              step={step}
              call={step.call}
              outcome={step.state}
              logUrl={logUrl}
              settle={step.state === "uncertain" ? settle?.(step.id) : undefined}
            />
          ) : (
            <>
              <StepLine step={step} outcome={step.state} />
              {step.state === "failed" && step.output !== undefined && (
                <span className="block ps-5.5 text-meta text-rose">{copy.refused({ why: step.output.head })}</span>
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

function StepLine({ step, outcome }: { step: ReplyStep; outcome: StepState }) {
  const waited = waitedOn(step);
  const mark = waited ? WAITED : MARK[outcome];
  const words = waited
    ? copy.waitingOn({ command: stepCommand(step) })
    : outcome === "running"
      ? copy.running({ label: step.label })
      : step.label;
  return (
    <span className="flex items-center gap-2 text-text-secondary">
      <span aria-hidden className={cn("w-3.5 text-center", mark.className)}>
        {mark.glyph}
      </span>
      <span className={cn(outcome === "running" && "text-text-strong")}>{words}</span>
      <span className="sr-only">{waited ? copy.waitedOutcome : copy.outcome[outcome]}</span>
    </span>
  );
}

/** How long, in the words the steps use. */
const minutesWords = (count: number | null) => (count === null ? null : messages.composer.minutes({ count }));

/** Why a refused step never ran, by who refused it. */
const DENIED = { policy: copy.deniedByPolicy, user: copy.deniedByUser, sandbox: copy.deniedBySandbox } as const;

/** The line under a tool step that says what happened, when its mark alone does not. */
const stepNote = (step: ReplyStep, outcome: StepState, now: Date): string | null => {
  switch (outcome) {
    case "running":
      return waitedOn(step)
        ? copy.waitingNote({ time: messages.composer.minutes({ count: minutesSince(step.startedAt ?? null, now) }) })
        : null;
    case "stopped":
      return copy.stopped({ time: minutesWords(minutesBetween(step.startedAt, step.endedAt)) });
    case "awaiting":
      return copy.awaiting;
    case "failed":
      return copy.failed;
    case "unfinished":
      return copy.unfinished;
    case "uncertain":
      return step.reason ?? copy.uncertain;
    case "denied":
      return DENIED[step.decidedBy ?? "policy"]({ reason: step.reason ?? "" });
    default:
      return null;
  }
};

function ToolStep({
  step,
  call,
  outcome,
  logUrl,
  settle,
}: {
  step: ReplyStep;
  call: ToolCall;
  outcome: StepState;
  logUrl: LogUrl;
  settle?: ReactNode;
}) {
  // A wait's clock moves once a minute (#1056).
  const now = useNow(waitedOn(step) ? 60_000 : null);
  const note = stepNote(step, outcome, now);
  return (
    <Collapsible className="flex flex-col gap-0.5">
      <CollapsibleTrigger className="group flex items-center gap-2 border-0 bg-transparent p-0 text-start text-detail text-text-secondary hover:text-text-strong focus-visible:outline-2 focus-visible:outline-focus-ring">
        <StepLine step={step} outcome={outcome} />
        <span aria-hidden className="text-label group-data-[state=open]:rotate-90">
          ›
        </span>
      </CollapsibleTrigger>
      {note !== null && (
        <span
          className={cn(
            "ps-5.5 text-meta",
            outcome === "denied" || outcome === "failed"
              ? "text-rose"
              : outcome === "running" || outcome === "stopped"
                ? "text-text-secondary"
                : "text-lantern",
          )}
        >
          {note}
        </span>
      )}
      {settle}
      <CollapsibleContent>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 ps-5.5 pt-0.5 text-meta text-text-secondary">
          <dt className="text-label">{copy.tool}</dt>
          <dd className="m-0">{call.tool}</dd>
          <dt className="text-label">{copy.operation}</dt>
          <dd className="m-0">{operationLabel(call.operation)}</dd>
          <dt className="text-label">{copy.targets}</dt>
          <dd className="m-0 break-all">{call.targets.length === 0 ? copy.noTargets : call.targets.join(", ")}</dd>
          {outcome === "uncertain" && step.startedAt !== undefined && (
            <>
              <dt className="text-label">{copy.started}</dt>
              <dd className="m-0">{formatTime(step.startedAt)}</dd>
            </>
          )}
        </dl>
        {step.output && <StepOutput output={step.output} logUrl={logUrl(step.id)} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What the call printed, with a link to the whole log when part of it was left out. */
function StepOutput({ output, logUrl }: { output: ToolOutput; logUrl: string }) {
  return (
    <OutputBlock
      output={output}
      className="ms-5.5 mt-1.5"
      whole={
        output.logged ? (
          <LogLink href={logUrl}>{copy.openLog({ size: formatBytes(output.totalBytes) })}</LogLink>
        ) : (
          <span className="text-label">{copy.noLog}</span>
        )
      }
    />
  );
}
