import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// The Hobbots tabs: plain labels on a line, the selected one bold with a lantern bar under it. Arrow
// keys move between tabs and select them, and Home and End go to the ends.
//
// Corners, the line's width and the bar's rounding read the skin variables (`--corner-control`,
// `--edge`), so Lamplight rounds and thins them and Workshop keeps them square.

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

// `line` draws the line the selected tab's bar sits on; `plain` leaves it out, for tabs in a header
// that already has a rule under it; `chip` is for chip tabs (see the trigger's `chip` variant), such
// as the docked Workbench's strip, and scrolls without a scrollbar.
const tabsListVariants = cva("flex shrink-0 gap-1 overflow-x-auto border-0 border-solid border-line", {
  variants: {
    variant: {
      line: "border-b-[length:var(--edge)]",
      plain: "",
      chip: "[scrollbar-width:none]",
    },
  },
  defaultVariants: { variant: "line" },
});

function TabsList({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List data-slot="tabs-list" className={cn(tabsListVariants({ variant }), className)} {...props} />
  );
}

// `bar` is a plain label, the selected one bold with a lantern bar under it on the list's line; `chip`
// is a small rounded chip, the selected one on a card, with no bar.
const tabsTriggerVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent whitespace-nowrap text-text-secondary",
    "hover:bg-hover hover:text-text-strong data-[state=active]:text-text-strong",
    "focus-ring focus-inset",
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        bar: [
          "gap-2 rounded-t-control px-3 pt-2.5 pb-3 text-[15px] leading-[23px] data-[state=active]:font-semibold",
          // The bar under the selected tab sits on the list's line, inset from the tab's sides.
          "after:pointer-events-none after:absolute after:inset-x-2.5 after:bottom-[calc(-1*var(--edge))] after:h-[3px] after:rounded-control after:bg-lantern after:opacity-0 data-[state=active]:after:opacity-100",
        ],
        chip: "gap-1.5 rounded-control px-2.5 py-1.5 text-ui data-[state=active]:bg-card",
      },
    },
    defaultVariants: { variant: "bar" },
  },
);

function TabsTrigger({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & VariantProps<typeof tabsTriggerVariants>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content data-slot="tabs-content" className={cn("focus-ring focus-inset", className)} {...props} />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
