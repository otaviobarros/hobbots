import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

// Status tags from the Hobbots component sheet, one family per state: Needs you is the only filled
// lantern tag, and Failed the only filled rose one, so the loud ones stay loud.
// Corners come from the theme's tag corner: rounded in Lamplight, square in Workshop.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-[5px] rounded-tag px-[7px] py-0.5 text-detail font-semibold whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // The five hob and work states. Each pair meets 4.5:1 in every theme (docs/design/themes.md).
        // Needs you and Failed are the only filled tags, so they stay loud.
        "needs-you": "bg-lantern text-on-lantern",
        working: "bg-line text-mint",
        // A hob with nothing to do right now.
        resting: "bg-line-2 text-text-secondary",
        // Quiet: secondary text, with the check (an svg or a badge-glyph span) in mint.
        done: "bg-line text-text-secondary [&>svg]:text-mint *:data-[slot=badge-glyph]:text-mint",
        failed: "bg-rose text-on-rose",
        // In progress, like Working.
        running: "bg-line text-mint",
        // Waiting on someone else: quiet, never lantern, so it does not read as Needs you.
        waiting: "bg-line-2 text-text-secondary",
        queued: "bg-line-2 text-text-strong",
        cancelled: "bg-line-2 text-text-secondary",
        // A thread the user archived: read-only until restored.
        archived: "bg-line-2 text-text-secondary",
        // An action blocked because the enforcement it needs is missing, such as "Needs the sandbox".
        blocked: "bg-line-2 text-text-secondary",
        live: "bg-rose text-on-rose",
        // A feature not built yet.
        later: "bg-line text-label",
        muted: "bg-line text-text-secondary",
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
