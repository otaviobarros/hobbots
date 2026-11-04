import { cn } from "cn";
import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";

// The Hobbots tabs: plain labels on a line, the selected one bold with a lantern bar under it. Arrow
// keys move between tabs and select them, and Home and End go to the ends.
//
// Corners, the line's width and the bar's rounding read the skin variables (`--corner-control`,
// `--edge`). Until the theme system sets them, the fallbacks give today's Workshop Night look:
// square corners and a 2px line.

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex shrink-0 gap-1 overflow-x-auto border-0 border-b-[length:var(--edge,2px)] border-solid border-line",
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
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-t-[var(--corner-control,0px)] border-0 bg-transparent px-3 pt-2.5 pb-3 text-[15px] leading-[23px] whitespace-nowrap text-secondary-text",
        "hover:bg-hover hover:text-text data-[state=active]:font-semibold data-[state=active]:text-text",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // The bar under the selected tab sits on the list's line, inset from the tab's sides.
        "after:pointer-events-none after:absolute after:inset-x-2.5 after:bottom-[calc(-1*var(--edge,2px))] after:h-[3px] after:rounded-[min(var(--corner-control,0px),2px)] after:bg-lantern after:opacity-0 data-[state=active]:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
