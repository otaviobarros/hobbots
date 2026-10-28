import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

// Hobbots buttons (docs/design/ui-ux.md): pixel corners, stepped 2px press, moonlight focus ring.
const buttonVariants = cva(
  "cut inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 border-0 whitespace-nowrap transition-transform duration-75 ease-[steps(2)] outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-lantern font-bold text-ground shadow-[0_4px_0_var(--color-lantern-shadow)] hover:bg-lantern-hover active:translate-y-0.5 active:shadow-[0_2px_0_var(--color-lantern-shadow)]",
        approve:
          "bg-mint font-bold text-ground shadow-[0_4px_0_var(--color-mint-deep)] active:translate-y-0.5 active:shadow-[0_2px_0_var(--color-mint-deep)]",
        outline: "border-2 border-solid border-control bg-transparent text-text hover:bg-line",
        deny: "border-2 border-solid border-rose bg-transparent text-rose hover:bg-line",
        chip: "border-2 border-solid border-control bg-transparent text-[13px] text-text hover:bg-line",
        ghost: "bg-transparent text-text hover:bg-hover",
        icon: "border-2 border-solid border-line-2 bg-transparent text-secondary-text [clip-path:none] hover:bg-line hover:text-text",
        link: "bg-transparent text-lantern [clip-path:none] hover:underline",
      },
      size: {
        default: "px-4 py-[9px]",
        sm: "px-3 py-1.5 text-sm",
        xs: "px-2 py-1 text-[13px]",
        icon: "size-[30px] p-0 text-sm",
      },
    },
    compoundVariants: [
      { variant: ["outline", "deny"], size: "default", className: "px-3 py-1.5" },
      { variant: "chip", size: "default", className: "px-2.5 py-[5px]" },
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
