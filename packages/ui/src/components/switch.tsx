import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// The Hobbots switch from the component sheet: a square track, mint-deep when on, and a knob that
// moves in steps (none with Reduce motion). The knob of an on switch is the light switch-knob color
// in every theme, so it stays readable on mint-deep in the light themes too.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-6 w-[46px] shrink-0 cursor-pointer border-2 border-solid border-control bg-line p-0 outline-none focus-visible:ring-2 focus-visible:ring-moonlight focus-visible:ring-offset-2 focus-visible:ring-offset-ground disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-mint-deep",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="absolute top-0.5 start-0.5 size-4 bg-text-strong transition-[inset-inline-start] duration-150 ease-(--ease-ui) motion-reduce:transition-none data-[state=checked]:start-6 data-[state=checked]:bg-switch-knob"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
