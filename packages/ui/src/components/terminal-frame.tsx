import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// The terminal's chrome: a dark frame with a strip of terminal tabs, its tool buttons and a search
// field. It keeps the terminal palette (`--color-term-*`) in every theme, since a terminal stays
// dark in the light themes too, and draws focus in `term-focus`, which shows on that dark ground.
// Corners and the edge read the skin, so Lamplight rounds them and Workshop keeps them square.

function TerminalFrame({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="terminal-frame"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-control border-(length:--edge) border-solid border-term-edge bg-term-ground text-term-text [--color-focus-ring:var(--color-term-focus)]",
        className,
      )}
      {...props}
    />
  );
}

/** The strip above the terminal: its tabs, then whatever tools follow them. */
function TerminalBar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="terminal-bar"
      className={cn("flex shrink-0 flex-wrap items-end gap-x-0.5 gap-y-1 bg-term-bar px-1.5 pt-1", className)}
      {...props}
    />
  );
}

function TerminalTabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="terminal-tabs-list"
      className={cn("flex min-w-0 gap-0.5 overflow-x-auto", className)}
      {...props}
    />
  );
}

/** A terminal tab: the dim label of an idle one, lifted onto the terminal's ground when it shows. */
function TerminalTabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="terminal-tabs-trigger"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-control border-0 bg-transparent px-2.5 pt-1 pb-1.5 font-mono text-meta whitespace-nowrap text-term-dim",
        "hover:text-term-strong data-[state=active]:bg-term-ground data-[state=active]:text-term-strong",
        "focus-ring focus-inset",
        className,
      )}
      {...props}
    />
  );
}

/** A tool in the terminal's strip, such as Split; `aria-pressed` lifts it like a picked tab. */
function TerminalButton({ className, type = "button", ...props }: React.ComponentProps<"button">) {
  return (
    <button
      data-slot="terminal-button"
      type={type}
      className={cn(
        "mb-1 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-control border-0 bg-transparent px-2.5 py-1 font-mono text-meta whitespace-nowrap text-term-dim",
        "hover:text-term-strong aria-pressed:bg-term-ground aria-pressed:text-term-strong disabled:pointer-events-none disabled:opacity-50",
        "focus-ring focus-inset",
        className,
      )}
      {...props}
    />
  );
}

/** The terminal's search field, on its strip. */
function TerminalSearchInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      data-slot="terminal-search-input"
      type="search"
      className={cn(
        "mb-1 h-6 w-36 min-w-0 rounded-control border-(length:--edge) border-solid border-term-edge bg-term-ground px-2 font-mono text-meta text-term-text placeholder:text-term-dim",
        "focus-ring [&::-webkit-search-cancel-button]:appearance-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A terminal's panel. Every one stays mounted, so each keeps its scroll and selection; only the
 * picked one shows, or with `split` every one shows side by side, a rule between them.
 */
function TerminalPane({
  className,
  split = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content> & { split?: boolean }) {
  return (
    <TabsPrimitive.Content
      data-slot="terminal-pane"
      data-split={split || undefined}
      forceMount
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col border-0 border-solid border-term-edge",
        "not-data-split:data-[state=inactive]:hidden data-split:not-first:border-s-(length:--edge)",
        className,
      )}
      {...props}
    />
  );
}

export {
  TerminalBar,
  TerminalButton,
  TerminalFrame,
  TerminalPane,
  TerminalSearchInput,
  TerminalTabsList,
  TerminalTabsTrigger,
};
