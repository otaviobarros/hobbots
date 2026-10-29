import { cn } from "cn";
import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";

// The Hobbots switch from the component sheet: a square track, mint-deep when on, and a knob that
// moves in steps (none with Reduce motion).
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
        className="absolute top-0.5 left-0.5 size-4 bg-text transition-[left] duration-150 ease-[steps(3)] motion-reduce:transition-none data-[state=checked]:left-6"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
