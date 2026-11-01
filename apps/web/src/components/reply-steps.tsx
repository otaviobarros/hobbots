import type { ReplyStep, ToolCall, ToolOutput } from "@hobbots/domain";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@hobbots/ui/components/collapsible";
import { cn } from "@hobbots/ui/lib/utils";
import { formatBytes, operationLabel, shownSteps } from "../lib/reply-steps.ts";
import { messages } from "./messages.ts";

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
};

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
}: {
  steps: ReadonlyArray<ReplyStep>;
  inProgress: boolean;
  logUrl: LogUrl;
}) {
  const shown = shownSteps(steps, inProgress);
  if (shown.length === 0) return null;
  return (
    <ol
      aria-label={copy.list}
      className="m-0 flex list-none flex-col gap-[3px] border-2 border-line bg-panel px-2.5 py-2 text-[13px]"
    >
      {shown.map((step) => (
        <li key={step.id} data-state={step.state}>
          {step.kind === "tool" && step.call ? (
            <ToolStep step={step} call={step.call} outcome={step.state} logUrl={logUrl} />
          ) : (
            <StepLine step={step} outcome={step.state} />
          )}
        </li>
      ))}
    </ol>
  );
}

function StepLine({ step, outcome }: { step: ReplyStep; outcome: StepState }) {
  const mark = MARK[outcome];
  return (
    <span className="flex items-center gap-2 text-secondary-text">
      <span aria-hidden className={cn("w-3.5 text-center", mark.className)}>
        {mark.glyph}
      </span>
      <span className={outcome === "running" ? "text-text" : undefined}>
        {outcome === "running" ? copy.running({ label: step.label }) : step.label}
      </span>
      <span className="sr-only">{copy.outcome[outcome]}</span>
    </span>
  );
}

/** Why a refused step never ran, by who refused it. */
const DENIED = { policy: copy.deniedByPolicy, user: copy.deniedByUser, sandbox: copy.deniedBySandbox } as const;

/** The line under a tool step that says what happened, when its mark alone does not. */
const stepNote = (step: ReplyStep, outcome: StepState): string | null => {
  switch (outcome) {
    case "awaiting":
      return copy.awaiting;
    case "failed":
      return copy.failed;
    case "unfinished":
      return copy.unfinished;
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
}: {
  step: ReplyStep;
  call: ToolCall;
  outcome: StepState;
  logUrl: LogUrl;
}) {
  const note = stepNote(step, outcome);
  return (
    <Collapsible className="flex flex-col gap-0.5">
      <CollapsibleTrigger className="group flex items-center gap-2 border-0 bg-transparent p-0 text-start text-[13px] text-secondary-text hover:text-text focus-visible:outline-2 focus-visible:outline-ring">
        <StepLine step={step} outcome={outcome} />
        <span aria-hidden className="text-label group-data-[state=open]:rotate-90">
          ›
        </span>
      </CollapsibleTrigger>
      {note !== null && (
        <span
          className={cn("ps-5.5 text-xs", outcome === "denied" || outcome === "failed" ? "text-rose" : "text-lantern")}
        >
          {note}
        </span>
      )}
      <CollapsibleContent>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 ps-5.5 pt-0.5 text-xs text-secondary-text">
          <dt className="text-label">{copy.tool}</dt>
          <dd className="m-0">{call.tool}</dd>
          <dt className="text-label">{copy.operation}</dt>
          <dd className="m-0">{operationLabel(call.operation)}</dd>
          <dt className="text-label">{copy.targets}</dt>
          <dd className="m-0 break-all">{call.targets.length === 0 ? copy.noTargets : call.targets.join(", ")}</dd>
        </dl>
        {step.output && <StepOutput output={step.output} logUrl={logUrl(step.id)} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

const OUTPUT_TEXT =
  "m-0 max-h-60 overflow-auto px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap break-all";

/**
 * What the call printed. Long output shows its start and its end, where the error usually is, with
 * how much was left out between them and a link to the whole log.
 */
function StepOutput({ output, logUrl }: { output: ToolOutput; logUrl: string }) {
  const cut = output.omittedBytes > 0;
  return (
    <figure aria-label={copy.output} className="m-0 ms-5.5 mt-1.5 flex min-w-0 flex-col border-2 border-line bg-deep">
      <figcaption className="border-b-2 border-line px-2.5 py-1 text-xs text-label">{copy.output}</figcaption>
      <pre className={OUTPUT_TEXT}>{output.head}</pre>
      {cut && (
        <>
          <p className="m-0 border-y-2 border-dashed border-line px-2.5 py-1 text-center text-xs text-label">
            {copy.omitted({ size: formatBytes(output.omittedBytes) })}
          </p>
          {/* Reversed, so the end, where an error usually is, shows first and the rest scrolls up. */}
          <div className="flex max-h-60 flex-col-reverse overflow-auto">
            <pre className={cn(OUTPUT_TEXT, "max-h-none overflow-visible")}>{output.tail}</pre>
          </div>
          <p className="m-0 border-t-2 border-line px-2.5 py-1 text-xs">
            {output.logged ? (
              <a
                href={logUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-lantern underline-offset-2 hover:underline"
              >
                {copy.openLog({ size: formatBytes(output.totalBytes) })}
              </a>
            ) : (
              <span className="text-label">{copy.noLog}</span>
            )}
          </p>
        </>
      )}
    </figure>
  );
}
