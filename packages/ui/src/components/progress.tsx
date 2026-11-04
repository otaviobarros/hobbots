import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Progress as ProgressPrimitive } from "radix-ui";
import type * as React from "react";

// A meter from the Hobbots component sheet: a track on line-2 and a fill in the tone's color.
// Corners and easing come from the look's skin, so the bar is round in Lamplight and square in
// Workshop.
const progressVariants = cva("relative flex w-full items-center overflow-hidden rounded-dot bg-line-2", {
  variants: {
    size: {
      // The Usage plan meter.
      default: "h-2.5",
      // The quest card's progress line.
      sm: "h-1.5",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

const indicatorVariants = cva(
  "size-full flex-1 rounded-dot transition-transform duration-200 ease-(--ease-ui) motion-reduce:transition-none",
  {
    variants: {
      tone: {
        default: "bg-mint",
        // Running low: the provider warns that little is left.
        low: "bg-lantern",
        // Used up: work pauses until it refills.
        out: "bg-rose",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
);

/** Keeps the value inside 0 and max, where Radix accepts it. */
const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value));

/**
 * A bar that fills to `value` out of `max` (100 by default). Give it a name with `aria-label` or
 * `aria-labelledby`, or hide it with `aria-hidden` when text beside it says the same.
 */
function Progress({
  className,
  value,
  max = 100,
  size = "default",
  tone = "default",
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value" | "max"> &
  VariantProps<typeof progressVariants> &
  VariantProps<typeof indicatorVariants> & { value: number; max?: number }) {
  const safeMax = max > 0 ? max : 100;
  const current = clamp(value, safeMax);
  const percent = (current / safeMax) * 100;

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-tone={tone}
      value={current}
      max={safeMax}
      className={cn(progressVariants({ size }), className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={indicatorVariants({ tone })}
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
