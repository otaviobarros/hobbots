import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

// Status tags from the Hobbots component sheet: bold, one color per state.
// Corners come from the theme's tag corner, which is square until the theme sets one.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-[5px] rounded-[var(--corner-tag,0)] px-[7px] py-0.5 text-xs font-bold whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        // The five hob and work states. Each pair meets 4.5:1 in every theme (docs/design/themes.md).
        // Needs you and Failed are the only filled tags, so they stay loud. Their text reads the
        // on-lantern and on-rose tokens, and falls back to ground until the theme defines them.
        "needs-you": "bg-lantern text-[var(--color-on-lantern,var(--color-ground))]",
        working: "bg-line text-mint",
        // A hob with nothing to do right now.
        resting: "bg-line-2 text-secondary-text",
        // Quiet: secondary text, with the check (an svg or a badge-glyph span) in mint.
        done: "bg-line text-secondary-text [&>svg]:text-mint *:data-[slot=badge-glyph]:text-mint",
        failed: "bg-rose text-[var(--color-on-rose,var(--color-ground))]",
        running: "bg-mint-deep text-text",
        waiting: "bg-lantern text-ground",
        queued: "bg-line-2 text-text",
        cancelled: "bg-line-2 text-secondary-text",
        // A thread the user archived: read-only until restored.
        archived: "bg-line-2 text-secondary-text",
        // An action blocked because the enforcement it needs is missing, such as "Needs the sandbox".
        blocked: "bg-line-2 text-secondary-text",
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
