import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// `default` is a form field; `title` is a larger one in the heading face, for a page's title, such as
// the Memory editor's.
const inputVariants = cva(
  "w-full min-w-0 rounded-control border border-input bg-transparent px-2.5 py-1 transition-colors focus-ring file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui file:font-(--button-weight) file:text-foreground placeholder:text-label disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: "h-8 text-body",
        title: "h-11 font-heading text-[20px]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return <input type={type} data-slot="input" className={cn(inputVariants({ variant }), className)} {...props} />;
}

export { Input };
