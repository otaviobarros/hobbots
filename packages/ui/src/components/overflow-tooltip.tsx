"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import { type ReactElement, useRef, useState } from "react";
import { TooltipContent } from "./tooltip.tsx";

// A line that may be cut short by `truncate` shows its whole text in a tooltip, but only while it
// is cut: a line that fits needs none. The child is the truncated element itself, such as a heading
// with `truncate`, and must take a ref.
function OverflowTooltip({ text, children }: { text: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  // Radix types its trigger as a button; with `asChild` it is the child, whatever its element.
  const line = useRef<HTMLButtonElement>(null);
  const cut = () => line.current !== null && line.current.scrollWidth > line.current.clientWidth;
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root open={open} onOpenChange={(next) => setOpen(next && cut())}>
        {/* Only a pointer opens it: a heading that takes focus as its view opens shows no tooltip. */}
        <TooltipPrimitive.Trigger ref={line} asChild onFocus={(event) => event.preventDefault()}>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipContent sideOffset={6} className="pointer-events-none max-w-md whitespace-normal">
          {text}
        </TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export { OverflowTooltip };
