import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// `default` is a field with its own border, and `deep` one on the deep ground with the control edge,
// such as an answer box in a card. `bare` has no border or fill, for a box that sits in a card which
// draws the field around it, such as a composer with its send row.
const textareaVariants = cva(
  "flex field-sizing-content min-h-16 w-full px-2.5 py-2 text-body transition-colors focus-ring placeholder:text-label disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "rounded-control border border-input bg-transparent disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        deep: "rounded-control border-(length:--edge) border-control bg-deep text-text-strong",
        bare: "resize-none rounded-control border-0 bg-transparent px-1 text-text-strong",
      },
      text: {
        body: "",
        mono: "font-mono text-ui leading-[22px]",
      },
    },
    defaultVariants: {
      variant: "default",
      text: "body",
    },
  },
);

function Textarea({
  className,
  variant = "default",
  text = "body",
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return <textarea data-slot="textarea" className={cn(textareaVariants({ variant, text }), className)} {...props} />;
}

export { Textarea };
