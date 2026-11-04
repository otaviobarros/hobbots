import { cn } from "cn";
import type * as React from "react";

// A stepper (docs/design/ui-ux.md): the steps of a short flow in a row, each with a bar under it.
// The current step's dot and bar are lantern, done steps show a check, and steps still to come are
// quiet. A done step is a button that goes back to it; the current and later steps are plain text,
// so the flow decides when the user moves forward.

type StepperProps = Omit<React.ComponentProps<"ol">, "children"> & {
  /** Each step's short name, in order. */
  steps: ReadonlyArray<string>;
  /** The current step, counting from 0. */
  current: number;
  /** Goes back to a done step. Left out, done steps are plain text too. */
  onPick?: ((index: number) => void) | undefined;
  /** The list's accessible name, such as "Summon steps". */
  "aria-label": string;
};

function Stepper({ steps, current, onPick, className, ...props }: StepperProps) {
  return (
    <ol data-slot="stepper" className={cn("m-0 flex list-none gap-2 p-0", className)} {...props}>
      {steps.map((label, index) => (
        <StepperStep
          key={label}
          label={label}
          number={index + 1}
          state={index < current ? "done" : index === current ? "current" : "later"}
          onPick={onPick && index < current ? () => onPick(index) : undefined}
        />
      ))}
    </ol>
  );
}

type StepState = "done" | "current" | "later";

const BAR: Record<StepState, string> = {
  done: "shadow-[inset_0_-3px_0_color-mix(in_srgb,var(--color-moonlight)_85%,transparent)]",
  current: "shadow-[inset_0_-3px_0_var(--color-lantern)]",
  later: "shadow-[inset_0_-3px_0_var(--color-line-2)]",
};

const DOT: Record<StepState, string> = {
  done: "bg-moonlight text-ground",
  current: "bg-lantern text-on-lantern",
  later: "bg-line-2 text-text-secondary",
};

function StepperStep({
  label,
  number,
  state,
  onPick,
}: {
  label: string;
  number: number;
  state: StepState;
  onPick: (() => void) | undefined;
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn("grid size-[22px] flex-none place-items-center rounded-dot text-meta font-bold", DOT[state])}
      >
        {state === "done" ? "✓" : number}
      </span>
      <span className="min-w-0 truncate text-sm">
        {label}
        {state === "done" && <span className="sr-only"> (done)</span>}
      </span>
    </>
  );
  const row = cn(
    "flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5",
    state === "current" ? "text-text-strong" : "text-label",
  );
  return (
    <li data-slot="stepper-step" data-state={state} className={cn("min-w-0 flex-1 pb-1.5", BAR[state])}>
      {onPick ? (
        <button
          type="button"
          onClick={onPick}
          className={cn(row, "cursor-pointer border-0 bg-transparent text-left hover:bg-hover hover:text-text-strong")}
        >
          {body}
        </button>
      ) : (
        <span aria-current={state === "current" ? "step" : undefined} className={row}>
          {body}
        </span>
      )}
    </li>
  );
}

export { Stepper };
