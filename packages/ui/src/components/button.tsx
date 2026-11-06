import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// Hobbots buttons (docs/design/ui-ux.md). Corners, focus ring and press come from the theme's skin.
const buttonVariants = cva(
  "cut-control inline-flex no-underline shrink-0 cursor-pointer items-center justify-center gap-2 border-0 whitespace-nowrap transition-transform duration-(--dur-press) ease-(--ease-press) select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "press bg-lantern font-bold text-ground [--press-color:var(--color-lantern-press)] hover:bg-lantern-hover",
        approve: "press bg-mint font-bold text-ground [--press-color:var(--color-mint-deep)]",
        outline: "border-(length:--edge) border-solid border-control bg-transparent text-text-strong hover:bg-line",
        deny: "border-(length:--edge) border-solid border-rose bg-transparent text-rose hover:bg-line",
        chip: "border-(length:--edge) border-solid border-control bg-transparent text-detail text-text-strong hover:bg-line data-[recommended=true]:border-mint-deep",
        // One of a question's choices (#740): a row with its label and what it does; the recommended one has a mint edge.
        choice:
          "border-(length:--edge) border-solid border-line-2 bg-panel text-start whitespace-normal text-text-strong items-start justify-start hover:border-control hover:bg-hover data-[recommended=true]:border-mint-deep",
        ghost: "bg-transparent text-text-strong hover:bg-hover",
        // A quiet action that should not draw the eye, such as the chat header's back arrow.
        quiet: "bg-transparent text-text-secondary hover:bg-hover hover:text-text-strong",
        // A quiet action that removes something, such as Delete in a Memory page's actions.
        quietDeny: "bg-transparent text-rose hover:bg-hover",
        icon: "border-(length:--edge) border-solid border-line-2 bg-transparent text-text-secondary [clip-path:none] hover:bg-line hover:text-text-strong aria-pressed:bg-line aria-pressed:text-text-strong",
        // A link that acts: `link`, underlined, and the underline turns lantern on hover.
        link: "bg-transparent text-link underline underline-offset-2 [clip-path:none] hover:decoration-lantern",
        // A text action beside other content, such as Show all: secondary text, underlined.
        text: "bg-transparent text-text-secondary underline underline-offset-2 [clip-path:none] hover:text-text-strong",
      },
      size: {
        default: "px-4 py-[9px]",
        sm: "px-3 py-1.5 text-ui",
        // As tall as the composer's icon Send, for the buttons that sit beside it (Stop, Wake, Queue).
        bar: "h-[34px] px-3 text-ui",
        xs: "px-2 py-1 text-detail",
        icon: "size-[30px] p-0 text-ui",
      },
    },
    compoundVariants: [
      { variant: ["outline", "deny"], size: "default", className: "px-3 py-1.5" },
      { variant: "chip", size: "default", className: "px-2.5 py-[5px]" },
      { variant: "choice", size: "default", className: "px-2.5 py-2" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
