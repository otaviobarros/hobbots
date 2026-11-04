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
// that already has a rule under it; `chip` draws each tab as a small chip with the selected one on a
// card and no bar, for a strip such as the docked Workbench's, and scrolls without a scrollbar.
function TabsList({
  className,
  variant = "line",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: "line" | "plain" | "chip" }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        "group/tabs flex shrink-0 gap-1 overflow-x-auto border-0 border-solid border-line",
        variant === "line" && "border-b-[length:var(--edge)]",
        variant === "chip" && "[scrollbar-width:none]",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-t-control border-0 bg-transparent px-3 pt-2.5 pb-3 text-[15px] leading-[23px] whitespace-nowrap text-text-secondary",
        "hover:bg-hover hover:text-text-strong data-[state=active]:font-semibold data-[state=active]:text-text-strong",
        "focus-ring focus-inset",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // The bar under the selected tab sits on the list's line, inset from the tab's sides.
        "after:pointer-events-none after:absolute after:inset-x-2.5 after:bottom-[calc(-1*var(--edge))] after:h-[3px] after:rounded-control after:bg-lantern after:opacity-0 data-[state=active]:after:opacity-100",
        // A chip: smaller, rounded all round, the selected one on a card with no bar under it.
        "group-data-[variant=chip]/tabs:gap-1.5 group-data-[variant=chip]/tabs:rounded-control group-data-[variant=chip]/tabs:px-2.5 group-data-[variant=chip]/tabs:py-1.5 group-data-[variant=chip]/tabs:text-[14px] group-data-[variant=chip]/tabs:leading-5 group-data-[variant=chip]/tabs:after:hidden group-data-[variant=chip]/tabs:data-[state=active]:bg-card group-data-[variant=chip]/tabs:data-[state=active]:font-normal",
        className,
      )}
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
