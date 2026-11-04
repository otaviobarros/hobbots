import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// An empty state: art, one line that says what will appear here, and an optional action.
// `page` fills a screen, such as an Inbox with nothing waiting. `section` sits in a list or a tab,
// such as an empty Archive or a hob with no chats yet. `card` puts it on the card surface.
const emptyVariants = cva(
  "group/empty flex w-full min-w-0 flex-col items-center justify-center text-center text-balance",
  {
    variants: {
      size: {
        section: "gap-2.5 px-6 py-11",
        page: "flex-1 gap-3 p-8",
      },
      surface: {
        plain: "",
        card: "cut bg-card",
      },
    },
    defaultVariants: {
      size: "section",
      surface: "plain",
    },
  },
);

function Empty({
  className,
  size = "section",
  surface = "plain",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyVariants>) {
  return (
    <div
      data-slot="empty"
      data-size={size}
      data-surface={surface}
      className={cn(emptyVariants({ size, surface }), className)}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex max-w-[460px] flex-col items-center gap-2.5 group-data-[size=page]/empty:gap-3", className)}
      {...props}
    />
  );
}

// `default` holds art at its own size: a hob on its ground or a pixel drawing.
// `icon` holds one line icon in the label color.
const emptyMediaVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
        icon: "size-7 text-label [&_svg:not([class*='size-'])]:size-7",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-media"
      data-variant={variant}
      aria-hidden="true"
      className={cn(emptyMediaVariants({ variant }), className)}
      {...props}
    />
  );
}

// The one line, in the heading font: Atkinson in Lamplight, Pixelify in Workshop. Pass `asChild`
// to render it as the screen's heading.
function EmptyTitle({ className, asChild = false, ...props }: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="empty-title"
      className={cn(
        "m-0 font-heading text-title font-(--heading-weight) text-text-strong",
        "group-data-[size=page]/empty:text-display",
        className,
      )}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-description"
      className={cn(
        "m-0 text-body text-text-secondary [&>a]:text-link [&>a]:underline [&>a]:underline-offset-[3px] [&>a:hover]:decoration-lantern",
        className,
      )}
      {...props}
    />
  );
}

// The action, or a primary and a quieter second action side by side.
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn("flex min-w-0 flex-wrap items-center justify-center gap-2", className)}
      {...props}
    />
  );
}

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
