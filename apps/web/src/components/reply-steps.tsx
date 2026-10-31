import type { ReplyStep } from "@hobbots/domain";

/**
 * What a running reply has done so far, as the runtime reports it: thinking now, tool calls
 * later. A finished step is ticked; the running one blinks until Reduce motion stops it.
 */
export function ReplySteps({ steps }: { steps: ReadonlyArray<ReplyStep> }) {
  if (steps.length === 0) return null;
  return (
    <ol aria-label="Reply steps" className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
      {steps.map((step) => (
        <li key={step.id} data-state={step.state} className="flex items-center gap-2 text-secondary-text">
          {step.state === "done" ? (
            <span aria-hidden className="w-3 text-mint">
              ✓
            </span>
          ) : (
            <span aria-hidden className="w-3 animate-hb-blink text-lantern">
              ●
            </span>
          )}
          <span className={step.state === "running" ? "text-text" : undefined}>
            {step.label}
            {step.state === "running" && "…"}
          </span>
          <span className="sr-only">{step.state === "done" ? "done" : "in progress"}</span>
        </li>
      ))}
    </ol>
  );
}
