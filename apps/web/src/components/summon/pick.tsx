import { cn } from "@hobbots/ui/lib/utils";
import { RadioLabel, type RadioLabelProps } from "../hob-form/hob-form.tsx";

/**
 * Summon's two kinds of option: a card and a small chip. Each is a label over a native radio, so a
 * group of them gets arrow keys, Space and screen reader support from the browser. The picked one
 * takes a focus-ring edge or fill, never a left-edge accent (STD-UI-006).
 */

const focus = "focus-ring-within";

const CARD =
  "flex min-w-0 cursor-pointer items-start gap-3 rounded-control bg-card p-3 text-left text-text-strong transition-colors duration-150 hover:bg-hover has-checked:shadow-[inset_0_0_0_2px_var(--color-focus-ring)]";

const CHIP =
  "inline-flex h-[26px] cursor-pointer items-center rounded-dot border border-line-2 px-2.5 text-detail text-text-secondary transition-colors duration-150 hover:border-control has-checked:border-text-strong has-checked:bg-text-strong has-checked:text-ground";

export function PickCard({ className, ...props }: RadioLabelProps) {
  return <RadioLabel {...props} className={cn(CARD, focus, className)} />;
}

export function PickChip({ className, ...props }: RadioLabelProps) {
  return <RadioLabel {...props} className={cn(CHIP, focus, className)} />;
}
