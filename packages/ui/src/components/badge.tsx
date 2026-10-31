import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

// Status tags from the Hobbots component sheet: square, bold, one color per state.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-[5px] px-[7px] py-0.5 text-xs font-bold whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        working: "bg-mint text-ground",
        running: "bg-mint-deep text-text",
        waiting: "bg-lantern text-ground",
        "needs-you": "bg-lantern text-ground",
        done: "bg-mint text-ground",
        queued: "bg-line-2 text-text",
        cancelled: "bg-line-2 text-secondary-text",
        // An action blocked because the enforcement it needs is missing, such as "Needs the sandbox".
        blocked: "bg-line-2 text-secondary-text",
        failed: "bg-rose text-ground",
        live: "bg-rose text-ground",
        later: "bg-lantern text-ground",
        muted: "bg-line text-secondary-text",
      },
    },
    defaultVariants: {
      variant: "muted",
    },
  },
);

function Badge({
  className,
  variant = "muted",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
